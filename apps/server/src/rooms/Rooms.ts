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
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * HQ fork: rooms group threads. The tables are created here rather than by the numbered
 * migrations so the fork never takes an id upstream will use next; the `hq_` prefix keeps them
 * clear of upstream's names. Membership is keyed on thread ids and is not cleaned up when a thread
 * is deleted: clients only show threads they know.
 *
 * Shelved files live in `<state dir>/shelves/<slug>/`, outside any worktree, so they outlive the
 * threads that made them and a room moves between machines by copying its folder. Document rows
 * name those files relative to the folder; an absolute ref is a file recorded before shelves had
 * folders, listed while it still exists.
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
    /** Recorded links, the files in the room's shelf folder, and member threads' PRs. */
    readonly shelf: (slug: string) => Effect.Effect<RoomShelf, RoomsError>;
    /** The folder holding a room's shelved files, on this server's host. */
    readonly shelfDir: (slug: string) => string;
    /**
     * Records a link on a room's shelf, or copies a file (an absolute path) into the room's shelf
     * folder as `name`, by default its file name; pull requests are refused (link them to a
     * thread). Adding a link again keeps it once and only replaces the title when one is given;
     * shelving a file again replaces the copy and moves it to the top.
     */
    readonly addDocument: (input: {
      readonly slug: string;
      readonly ref: string;
      readonly title?: string | undefined;
      readonly name?: string | undefined;
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

/** A path inside a shelf folder as stored and shown: `/`-separated on every platform. */
const portable = (path: Path.Path, relative: string) => relative.split(path.sep).join("/");

/** Files below `dir`, skipping dot paths, titled by their path inside it. */
const shelfFiles = (fs: FileSystem.FileSystem, path: Path.Path, dir: string) =>
  fs.readDirectory(dir, { recursive: true }).pipe(
    Effect.flatMap((relatives) =>
      Effect.forEach(
        relatives.filter(
          (relative) => !relative.split(path.sep).some((segment) => segment.startsWith(".")),
        ),
        (relative) =>
          fs.stat(path.join(dir, relative)).pipe(
            Effect.map((info): ReadonlyArray<ShelfRow> =>
              info.type === "File"
                ? [
                    {
                      ref: path.join(dir, relative),
                      title: portable(path, relative),
                      kind: fileKind(relative),
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
    // Nothing shelved yet.
    Effect.orElseSucceed((): ReadonlyArray<ShelfRow> => []),
  );

const fileKind = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "file";

const PR_URL =
  /^https:\/\/(?:github\.com\/([^/]+)\/([^/]+)\/pull|app\.graphite\.(?:com|dev)\/github\/pr\/([^/]+)\/([^/]+))\/(\d+)/i;

/** A shelf ref that is a URL rather than a file. */
export const isShelfLink = (ref: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(ref);

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
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  yield* ensureSchema;
  const shelfDir = (slug: string) => path.join(config.stateDir, "shelves", slug);
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
        const room = yield* find(slug);
        const recorded = yield* sql<ShelfRow>`
          SELECT ref, title, kind, thread_id AS "threadId", added_at AS "addedAt"
          FROM hq_room_documents WHERE room_slug = ${slug}
        `;
        // PR links live on each member thread.
        const shells = (yield* Effect.forEach(
          room.threadIds,
          (threadId) =>
            threads.getThreadShell(ThreadId.make(threadId)).pipe(Effect.orElseSucceed(() => null)),
          { concurrency: 8 },
        )).filter((shell) => shell !== null);
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

        const dir = shelfDir(slug);
        const docs = new Map<string, ShelfRow>();
        for (const row of recorded) {
          if (row.kind === "link" || isShelfLink(row.ref)) {
            docs.set(row.ref, row);
            continue;
          }
          const ref = path.isAbsolute(row.ref) ? row.ref : path.join(dir, row.ref);
          if (yield* fs.exists(ref).pipe(Effect.orElseSucceed(() => false))) {
            docs.set(ref, { ...row, ref });
          }
        }
        // Files that arrived without shelf_add (written straight into the folder, or copied from
        // another machine) are titled by their path.
        for (const file of yield* shelfFiles(fs, path, dir)) {
          if (!docs.has(file.ref)) docs.set(file.ref, file);
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
        const addedAt = yield* nowIso;
        if (isShelfLink(input.ref)) {
          const [row] = yield* sql<{ title: string }>`
            INSERT INTO hq_room_documents (room_slug, ref, title, kind, thread_id, added_at)
            VALUES (${input.slug}, ${input.ref}, ${input.title ?? input.ref}, 'link',
              ${input.threadId}, ${addedAt})
            ON CONFLICT (room_slug, ref) DO UPDATE SET
              title = COALESCE(${input.title ?? null}, title)
            RETURNING title
          `;
          return { ref: input.ref, title: row?.title ?? input.ref, kind: "link" };
        }

        const source = path.resolve(input.ref);
        const info = yield* fs
          .stat(source)
          .pipe(
            Effect.mapError(() => new RoomsError({ message: `There is no file at ${source}.` })),
          );
        if (info.type !== "File") {
          return yield* new RoomsError({
            message: `${source} is not a file. Shelve the files in a folder one at a time.`,
          });
        }
        const dir = shelfDir(input.slug);
        // A file already in the folder (written there directly) is recorded where it is.
        const inside = path.relative(dir, source);
        const outside = inside.startsWith("..") || path.isAbsolute(inside);
        const name = path.normalize(input.name ?? (outside ? path.basename(source) : inside));
        if (
          path.isAbsolute(name) ||
          name.split(path.sep).some((segment) => segment === ".." || segment.startsWith("."))
        ) {
          return yield* new RoomsError({
            message: `${input.name} is not a usable shelf name: use a relative path without dot segments, like notes/plan.md.`,
          });
        }
        const target = path.join(dir, name);
        if (target !== source) {
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.copyFile(source, target);
        }
        const kind = fileKind(name);
        const ref = portable(path, name);
        const [row] = yield* sql<{ title: string }>`
          INSERT INTO hq_room_documents (room_slug, ref, title, kind, thread_id, added_at)
          VALUES (${input.slug}, ${ref}, ${input.title ?? ref}, ${kind}, ${input.threadId},
            ${addedAt})
          ON CONFLICT (room_slug, ref) DO UPDATE SET
            title = COALESCE(${input.title ?? null}, title),
            thread_id = excluded.thread_id,
            added_at = excluded.added_at
          RETURNING title
        `;
        return { ref: target, title: row?.title ?? ref, kind };
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
    shelfDir,
    addDocument,
    list,
    stream,
  });
});

export const layer = Layer.effect(Rooms, make);
