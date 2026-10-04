import {
  ROOM_NOTE_MAX_LENGTH,
  ROOM_SECTIONS,
  type Room,
  type RoomCreateInput,
  RoomList,
  type RoomReorderInput,
  type RoomSection,
  type RoomSetThreadInput,
  RoomShelf,
  type RoomShelfDoc,
  RoomsError,
  type RoomUpdateInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

/**
 * HQ fork: rooms group threads. The tables are created here rather than by the numbered
 * migrations so the fork never takes an id upstream will use next; the `hq_` prefix keeps them
 * clear of upstream's names. Membership is keyed on thread ids and is not cleaned up when a thread
 * is deleted: clients only show threads they know.
 */
export class Rooms extends Context.Service<
  Rooms,
  {
    readonly create: (input: RoomCreateInput) => Effect.Effect<Room, RoomsError>;
    /** Renames, edits the outcome, archives or unarchives. */
    readonly update: (input: RoomUpdateInput) => Effect.Effect<Room, RoomsError>;
    /**
     * Replaces a room's note (an empty body clears it), recording the thread that wrote it.
     * `basedOn` is the note revision the writer read (null for no note); a write based on an older
     * revision is refused so the writer can reread and merge.
     */
    readonly setNote: (input: {
      readonly slug: string;
      readonly body: string;
      readonly threadId: string | null;
      readonly basedOn: number | null;
    }) => Effect.Effect<Room, RoomsError>;
    readonly reorder: (input: RoomReorderInput) => Effect.Effect<void, RoomsError>;
    readonly setThread: (input: RoomSetThreadInput) => Effect.Effect<void, RoomsError>;
    /** Puts a thread in one open room, taking it out of the others; null takes it out of all. */
    readonly moveThread: (input: {
      readonly threadId: string;
      readonly slug: string | null;
    }) => Effect.Effect<void, RoomsError>;
    /** Recorded documents, files under `cc/<slug>/` in member worktrees, and member threads' PRs. */
    readonly shelf: (slug: string) => Effect.Effect<RoomShelf, RoomsError>;
    /**
     * Records a link or file on a room's shelf; pull requests are refused (link them to a thread).
     * Adding a ref again keeps it once and only replaces the title when one is given.
     */
    readonly addDocument: (input: {
      readonly slug: string;
      readonly ref: string;
      readonly title?: string | undefined;
      readonly threadId: string | null;
    }) => Effect.Effect<{ ref: string; title: string; kind: string }, RoomsError>;
    readonly list: Effect.Effect<RoomList, RoomsError>;
    /** Emits every room first, then the full list after each change. */
    readonly stream: Stream.Stream<RoomList>;
  }
>()("t3/rooms/Rooms") {}

const ensureSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hq_rooms (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT '',
      section TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hq_room_threads (
      room_slug TEXT NOT NULL REFERENCES hq_rooms(slug) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (room_slug, thread_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hq_room_documents (
      room_slug TEXT NOT NULL REFERENCES hq_rooms(slug) ON DELETE CASCADE,
      ref TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      thread_id TEXT,
      added_at TEXT NOT NULL,
      PRIMARY KEY (room_slug, ref)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hq_room_notes (
      room_slug TEXT PRIMARY KEY REFERENCES hq_rooms(slug) ON DELETE CASCADE,
      body TEXT NOT NULL,
      thread_id TEXT,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    ) WITHOUT ROWID
  `;
  // Added after the table first shipped. Another process (the CLI import, say) may add it first.
  const noteColumns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('hq_room_notes')`;
  if (!noteColumns.some((column) => column.name === "revision")) {
    yield* sql`ALTER TABLE hq_room_notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`.pipe(
      Effect.catchIf(
        (error) => String(error).includes("duplicate column"),
        () => Effect.void,
      ),
    );
  }
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const decodeRoomList = Schema.decodeUnknownEffect(RoomList);

const isRoomsError = Schema.is(RoomsError);
const roomsError = (message: string) => (cause: unknown) => new RoomsError({ message, cause });

const decodeRoomShelf = Schema.decodeUnknownEffect(RoomShelf);

interface ShelfRow {
  readonly ref: string;
  readonly title: string;
  readonly kind: string;
  readonly threadId: string | null;
  readonly addedAt: string;
}

/** Files below `dir`, skipping dot paths; titled by their path inside it as HQ did. */
const shelfFiles = (fs: FileSystem.FileSystem, dir: string) =>
  fs.readDirectory(dir, { recursive: true }).pipe(
    Effect.flatMap((paths) =>
      Effect.forEach(
        paths.filter((path) => !path.split("/").some((segment) => segment.startsWith("."))),
        (path) =>
          fs.stat(`${dir}/${path}`).pipe(
            Effect.map((info): ReadonlyArray<ShelfRow> =>
              info.type === "File"
                ? [
                    {
                      ref: `${dir}/${path}`,
                      title: path,
                      kind: fileKind(path),
                      threadId: null,
                      addedAt: Option.getOrElse(
                        Option.map(info.mtime, (mtime) => mtime.toISOString()),
                        () => "",
                      ),
                    },
                  ]
                : [],
            ),
            Effect.orElseSucceed(() => []),
          ),
        { concurrency: 16 },
      ),
    ),
    Effect.map((files) => files.flat()),
    // No `cc/<slug>` folder in this worktree.
    Effect.orElseSucceed((): ReadonlyArray<ShelfRow> => []),
  );

const fileKind = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "file";

const PR_URL =
  /^https:\/\/(?:github\.com\/([^/]+)\/([^/]+)\/pull|app\.graphite\.(?:com|dev)\/github\/pr\/([^/]+)\/([^/]+))\/(\d+)/i;

/** Pull requests reach the shelf by being linked to a room thread, never recorded on it. */
const isPullRequestUrl = (ref: string) => PR_URL.test(ref);

/** A linked PR's shelf link: Graphite's, for GitHub PRs. */
export function shelfPrRef(url: string): string {
  const match = PR_URL.exec(url);
  if (!match) return url;
  const [, owner = match[3]!, repo = match[4]!] = match;
  return `https://app.graphite.com/github/pr/${owner.toLowerCase()}/${repo.toLowerCase()}/${match[5]}`;
}

const listRooms = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    slug: string;
    title: string;
    outcome: string;
    section: string;
    archivedAt: string | null;
    threadIds: string;
    noteBody: string | null;
    noteThreadId: string | null;
    noteUpdatedAt: string | null;
    noteRevision: number | null;
  }>`
    SELECT
      slug,
      title,
      outcome,
      section,
      archived_at AS "archivedAt",
      (
        SELECT json_group_array(thread_id)
        FROM hq_room_threads t
        WHERE t.room_slug = r.slug
      ) AS "threadIds",
      n.body AS "noteBody",
      n.thread_id AS "noteThreadId",
      n.updated_at AS "noteUpdatedAt",
      n.revision AS "noteRevision"
    FROM hq_rooms r
    LEFT JOIN hq_room_notes n ON n.room_slug = r.slug
    ORDER BY
      CASE section WHEN 'today' THEN 0 WHEN 'permanent' THEN 1 ELSE 2 END,
      position,
      slug
  `;
  return yield* decodeRoomList(
    rows.map(({ noteBody, noteThreadId, noteUpdatedAt, noteRevision, ...row }) => ({
      ...row,
      threadIds: JSON.parse(row.threadIds) as unknown,
      note:
        noteBody === null
          ? null
          : {
              body: noteBody,
              threadId: noteThreadId,
              updatedAt: noteUpdatedAt,
              revision: noteRevision,
            },
    })),
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  yield* ensureSchema;
  const changes = yield* PubSub.unbounded<RoomList>();

  const list = listRooms.pipe(
    Effect.mapError(roomsError("Could not read rooms.")),
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  const publish = list.pipe(Effect.flatMap((rooms) => PubSub.publish(changes, rooms)));
  const find = (slug: string) =>
    list.pipe(
      Effect.flatMap((rooms) => {
        const room = rooms.find((each) => each.slug === slug);
        return room
          ? Effect.succeed(room)
          : Effect.fail(new RoomsError({ message: `There is no room called ${slug}.` }));
      }),
    );
  const run = <A, E>(message: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isRoomsError(cause) ? cause : new RoomsError({ message, cause }),
      ),
    );

  const create = (input: RoomCreateInput) =>
    run(
      "Could not create the room.",
      Effect.gen(function* () {
        const existing = (yield* list).find((room) => room.slug === input.slug);
        if (existing) {
          return yield* new RoomsError({
            message: existing.archivedAt
              ? `An archived room is called ${input.slug}; unarchive it or pick another name.`
              : `A room called ${input.slug} already exists.`,
          });
        }
        const createdAt = yield* nowIso;
        yield* sql`
          INSERT INTO hq_rooms (slug, title, outcome, section, position, created_at)
          SELECT ${input.slug}, ${input.title}, ${input.outcome}, ${input.section},
            COALESCE(MAX(position) + 1, 0), ${createdAt}
          FROM hq_rooms WHERE section = ${input.section}
        `;
        yield* publish;
        return yield* find(input.slug);
      }),
    );

  const writeNote = (slug: string, body: string, threadId: string | null, basedOn: number | null) =>
    Effect.gen(function* () {
      const [current] = yield* sql<{
        updatedAt: string;
        threadId: string | null;
        revision: number;
      }>`
        SELECT updated_at AS "updatedAt", thread_id AS "threadId", revision
        FROM hq_room_notes WHERE room_slug = ${slug}
      `;
      if ((current?.revision ?? null) !== basedOn) {
        return yield* new RoomsError({
          message: current
            ? `The room note changed since you read it: ${current.threadId ? `thread ${current.threadId}` : "a user"} wrote revision ${current.revision} at ${current.updatedAt}. Read room_context again, merge your change into the current note, and retry with basedOn ${current.revision}.`
            : "This room has no note yet. Read room_context again and retry with basedOn null.",
        });
      }
      const trimmed = body.trim();
      if (trimmed.length > ROOM_NOTE_MAX_LENGTH) {
        return yield* new RoomsError({
          message: `A room note holds at most ${ROOM_NOTE_MAX_LENGTH} characters (this one has ${trimmed.length}). Keep where things stand and what is next; put history in a shelf document.`,
        });
      }
      const updatedAt = yield* nowIso;
      yield* sql`
        INSERT INTO hq_room_notes (room_slug, body, thread_id, updated_at, revision)
        VALUES (${slug}, ${trimmed}, ${threadId}, ${updatedAt}, ${(current?.revision ?? 0) + 1})
        ON CONFLICT (room_slug) DO UPDATE SET
          body = excluded.body,
          thread_id = excluded.thread_id,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `;
    });

  const setNote = (input: {
    readonly slug: string;
    readonly body: string;
    readonly threadId: string | null;
    readonly basedOn: number | null;
  }) =>
    run(
      "Could not update the room note.",
      Effect.gen(function* () {
        yield* find(input.slug);
        // One transaction, so no write lands between the version check and this one.
        yield* sql.withTransaction(
          writeNote(input.slug, input.body, input.threadId, input.basedOn),
        );
        yield* publish;
        return yield* find(input.slug);
      }),
    );

  const update = (input: RoomUpdateInput) =>
    run(
      "Could not update the room.",
      Effect.gen(function* () {
        yield* find(input.slug);
        if (input.note !== undefined) {
          if (input.noteBasedOn === undefined) {
            return yield* new RoomsError({
              message: "A note update needs noteBasedOn: the revision it was based on, or null.",
            });
          }
          yield* sql.withTransaction(writeNote(input.slug, input.note, null, input.noteBasedOn));
        }
        const archivedAt = yield* nowIso;
        yield* sql`
          UPDATE hq_rooms SET
            title = COALESCE(${input.title ?? null}, title),
            outcome = COALESCE(${input.outcome ?? null}, outcome),
            archived_at = CASE ${input.archived === undefined ? null : input.archived ? 1 : 0}
              WHEN 1 THEN COALESCE(archived_at, ${archivedAt})
              WHEN 0 THEN NULL
              ELSE archived_at
            END
          WHERE slug = ${input.slug}
        `;
        yield* publish;
        return yield* find(input.slug);
      }),
    );

  const reorder = (input: RoomReorderInput) =>
    run(
      "Could not reorder rooms.",
      sql
        .withTransaction(
          Effect.forEach(
            ROOM_SECTIONS.flatMap((section: RoomSection) =>
              input[section].map((slug, position) => ({ slug, section, position })),
            ),
            ({ slug, section, position }) =>
              sql`UPDATE hq_rooms SET section = ${section}, position = ${position} WHERE slug = ${slug}`,
            { discard: true },
          ),
        )
        .pipe(Effect.andThen(publish)),
    );

  const setThread = (input: RoomSetThreadInput) =>
    run(
      "Could not change the room's threads.",
      Effect.gen(function* () {
        yield* find(input.slug);
        if (input.member) {
          const addedAt = yield* nowIso;
          yield* sql`
            INSERT OR IGNORE INTO hq_room_threads (room_slug, thread_id, added_at)
            VALUES (${input.slug}, ${input.threadId}, ${addedAt})
          `;
        } else {
          yield* sql`
            DELETE FROM hq_room_threads
            WHERE room_slug = ${input.slug} AND thread_id = ${input.threadId}
          `;
        }
        yield* publish;
      }),
    );

  const moveThread = (input: { readonly threadId: string; readonly slug: string | null }) =>
    run(
      "Could not move the thread.",
      Effect.gen(function* () {
        if (input.slug !== null) {
          const room = yield* find(input.slug);
          if (room.archivedAt) {
            return yield* new RoomsError({ message: `The room ${input.slug} is archived.` });
          }
        }
        const addedAt = yield* nowIso;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Archived rooms keep their history.
            yield* sql`
              DELETE FROM hq_room_threads
              WHERE thread_id = ${input.threadId}
                AND room_slug IS NOT ${input.slug}
                AND room_slug IN (SELECT slug FROM hq_rooms WHERE archived_at IS NULL)
            `;
            if (input.slug !== null) {
              yield* sql`
                INSERT OR IGNORE INTO hq_room_threads (room_slug, thread_id, added_at)
                VALUES (${input.slug}, ${input.threadId}, ${addedAt})
              `;
            }
          }),
        );
        yield* publish;
      }),
    );

  const shelf = (slug: string) =>
    run(
      "Could not read the shelf.",
      Effect.gen(function* () {
        yield* find(slug);
        const recorded = yield* sql<ShelfRow>`
          SELECT ref, title, kind, thread_id AS "threadId", added_at AS "addedAt"
          FROM hq_room_documents WHERE room_slug = ${slug}
        `;
        // Member threads come from the orchestrator; PR links live on each thread.
        const room = yield* find(slug);
        const shells = (yield* Effect.forEach(
          room.threadIds,
          (threadId) =>
            threads.getThreadShell(ThreadId.make(threadId)).pipe(Effect.orElseSucceed(() => null)),
          { concurrency: 8 },
        )).filter((shell) => shell !== null);
        const projectRoots = new Map(
          (yield* projects
            .listShells({ projectIds: [...new Set(shells.map((shell) => shell.projectId))] })
            .pipe(Effect.orElseSucceed(() => []))).map((project) => [
            project.id,
            project.workspaceRoot,
          ]),
        );
        const members = shells.map((shell) => ({
          threadId: shell.id,
          root: shell.worktreePath ?? projectRoots.get(shell.projectId) ?? null,
        }));
        const prs = shells.flatMap((shell) =>
          visibleThreadPullRequests(shell.pullRequests ?? []).map((link) => ({
            threadId: shell.id,
            repository: link.repository,
            number: link.number,
            url: link.url,
            linkedAt: link.linkedAt,
            title: link.snapshot?.title ?? null,
            state: link.snapshot?.state ?? null,
            isDraft: link.snapshot?.isDraft ?? false,
          })),
        );

        const docs = new Map<string, ShelfRow>();
        for (const row of recorded) {
          if (
            !row.ref.startsWith("/") ||
            (yield* fs.exists(row.ref).pipe(Effect.orElseSucceed(() => false)))
          ) {
            docs.set(row.ref, row);
          }
        }
        const roots = new Map<string, string>();
        for (const member of members) {
          if (member.root && !roots.has(member.root)) roots.set(member.root, member.threadId);
        }
        for (const [root, threadId] of roots) {
          for (const file of yield* shelfFiles(fs, `${root}/cc/${slug}`)) {
            const existing = docs.get(file.ref);
            docs.set(
              file.ref,
              existing
                ? { ...existing, threadId: existing.threadId ?? threadId }
                : { ...file, threadId },
            );
          }
        }
        for (const pr of prs) {
          const ref = shelfPrRef(pr.url);
          const prState =
            pr.state === "open" && pr.isDraft ? "draft" : (pr.state as RoomShelfDoc["prState"]);
          docs.set(ref, {
            ref,
            title: pr.title ?? `${pr.repository} #${pr.number}`,
            kind: "pr",
            threadId: pr.threadId,
            addedAt: pr.linkedAt,
            ...(prState ? { prState } : {}),
          });
        }
        return yield* decodeRoomShelf(
          [...docs.values()].toSorted((a, b) => b.addedAt.localeCompare(a.addedAt)),
        );
      }),
    );

  const addDocument: Rooms["Service"]["addDocument"] = (input) =>
    run(
      "Could not add to the shelf.",
      Effect.gen(function* () {
        yield* find(input.slug);
        if (isPullRequestUrl(input.ref)) {
          return yield* new RoomsError({
            message:
              "Link pull requests to their thread with link_pull_request instead; the shelf lists every PR linked to a thread in the room.",
          });
        }
        const ref = input.ref;
        const local = ref.startsWith("/");
        const kind = local ? fileKind(ref) : "link";
        const fallbackTitle = local ? ref.slice(ref.lastIndexOf("/") + 1) : ref;
        const addedAt = yield* nowIso;
        const [row] = yield* sql<{ title: string }>`
          INSERT INTO hq_room_documents (room_slug, ref, title, kind, thread_id, added_at)
          VALUES (${input.slug}, ${ref}, ${input.title ?? fallbackTitle}, ${kind},
            ${input.threadId}, ${addedAt})
          ON CONFLICT (room_slug, ref) DO UPDATE SET
            title = COALESCE(${input.title ?? null}, title)
          RETURNING title
        `;
        return { ref, title: row?.title ?? fallbackTitle, kind };
      }),
    );

  // One-slot sliding mailbox per subscriber: lists are whole states, so a slow socket only needs
  // the newest one.
  const stream: Rooms["Service"]["stream"] = Stream.callback<RoomList>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, yield* list.pipe(Effect.orDie));
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((rooms) => Effect.sync(() => Queue.offerUnsafe(mailbox, rooms))),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  return Rooms.of({
    create,
    update,
    setNote,
    reorder,
    setThread,
    moveThread,
    shelf,
    addDocument,
    list,
    stream,
  });
});

export const layer = Layer.effect(Rooms, make);
