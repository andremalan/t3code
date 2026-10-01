import * as NodeSqlite from "node:sqlite";

import {
  ROOM_SECTIONS,
  type Room,
  type RoomCreateInput,
  RoomList,
  type RoomReorderInput,
  type RoomSection,
  type RoomSetThreadInput,
  RoomsError,
  type RoomUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
    readonly reorder: (input: RoomReorderInput) => Effect.Effect<void, RoomsError>;
    readonly setThread: (input: RoomSetThreadInput) => Effect.Effect<void, RoomsError>;
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
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const decodeRoomList = Schema.decodeUnknownEffect(RoomList);

const isRoomsError = Schema.is(RoomsError);
const roomsError = (message: string) => (cause: unknown) => new RoomsError({ message, cause });

const listRooms = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    slug: string;
    title: string;
    outcome: string;
    section: string;
    archivedAt: string | null;
    threadIds: string;
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
      ) AS "threadIds"
    FROM hq_rooms r
    ORDER BY
      CASE section WHEN 'today' THEN 0 WHEN 'permanent' THEN 1 ELSE 2 END,
      position,
      slug
  `;
  return yield* decodeRoomList(
    rows.map((row) => ({ ...row, threadIds: JSON.parse(row.threadIds) as unknown })),
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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

  const update = (input: RoomUpdateInput) =>
    run(
      "Could not update the room.",
      Effect.gen(function* () {
        yield* find(input.slug);
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

  return Rooms.of({ create, update, reorder, setThread, stream });
});

export const layer = Layer.effect(Rooms, make);

export interface HqImportResult {
  readonly rooms: number;
  readonly threads: number;
  /** HQ members whose session no live T3 thread runs (cmux sessions, deleted threads). */
  readonly skippedMembers: number;
}

/**
 * Copies rooms and their T3 threads from an HQ state directory (`hq.sqlite`, and
 * `config/ROOM-ORDER.json` for sections). HQ keys members on provider session ids; this resolves
 * them to the thread whose resume cursor names that session, as HQ does. Existing rooms and
 * memberships are kept, so it can be rerun.
 */
export const importHqRooms = (stateDir: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureSchema;
    const fs = yield* FileSystem.FileSystem;
    const hq = yield* Effect.try({
      try: () => readHqDatabase(`${stateDir}/hq.sqlite`),
      catch: roomsError(`Could not read ${stateDir}/hq.sqlite.`),
    });
    // No saved order puts every room in Permanent, as in HQ.
    const order = yield* fs.readFileString(`${stateDir}/config/ROOM-ORDER.json`).pipe(
      Effect.map((text) => JSON.parse(text) as HqRoomOrder),
      Effect.orElseSucceed((): HqRoomOrder => ({})),
    );
    const sessions = yield* sql<{ session: string | null; threadId: string }>`
      SELECT
        COALESCE(
          json_extract(r.resume_cursor_json, '$.resume'),
          json_extract(r.resume_cursor_json, '$.threadId'),
          json_extract(r.resume_cursor_json, '$.sessionId')
        ) AS "session",
        r.thread_id AS "threadId"
      FROM provider_session_runtime r
      JOIN projection_threads t ON t.thread_id = r.thread_id AND t.deleted_at IS NULL
    `;
    const threadBySession = new Map(
      sessions.flatMap((row) => (row.session ? [[row.session, row.threadId] as const] : [])),
    );
    const placement = roomPlacement(
      hq.rooms.map((room) => room.slug),
      order,
    );
    const createdAt = yield* nowIso;

    let rooms = 0;
    let threads = 0;
    let skippedMembers = 0;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const room of hq.rooms) {
          const { section, position } = placement.get(room.slug)!;
          const inserted = yield* sql<{ slug: string }>`
            INSERT OR IGNORE INTO hq_rooms
              (slug, title, outcome, section, position, created_at, archived_at)
            VALUES (${room.slug}, ${room.title}, ${room.outcome}, ${section}, ${position},
              ${room.createdAt}, ${room.archivedAt})
            RETURNING slug
          `;
          rooms += inserted.length;
        }
        for (const member of hq.members) {
          const threadId = threadBySession.get(member.session);
          if (!threadId) {
            skippedMembers++;
            continue;
          }
          const inserted = yield* sql<{ threadId: string }>`
            INSERT OR IGNORE INTO hq_room_threads (room_slug, thread_id, added_at)
            VALUES (${member.slug}, ${threadId}, ${member.attachedAt || createdAt})
            RETURNING thread_id AS "threadId"
          `;
          threads += inserted.length;
        }
      }),
    );
    return { rooms, threads, skippedMembers } satisfies HqImportResult;
  });

type HqRoomOrder = Partial<Record<RoomSection, ReadonlyArray<string>>>;

function readHqDatabase(path: string) {
  const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    const rooms = db
      .prepare(
        `SELECT r.slug, r.title, COALESCE(w.outcome, '') AS outcome, r.created_at AS createdAt,
           r.archived_at AS archivedAt
         FROM rooms r LEFT JOIN room_work w ON w.room_id = r.id
         ORDER BY r.created_at`,
      )
      .all() as unknown as ReadonlyArray<{
      slug: string;
      title: string;
      outcome: string;
      createdAt: string;
      archivedAt: string | null;
    }>;
    const members = db
      .prepare(
        `SELECT r.slug, m.session_uuid AS session, m.attached_at AS attachedAt
         FROM room_members m JOIN rooms r ON r.id = m.room_id`,
      )
      .all() as unknown as ReadonlyArray<{ slug: string; session: string; attachedAt: string }>;
    return { rooms, members };
  } finally {
    db.close();
  }
}

/** HQ's saved sections, with unlisted rooms appended to Permanent as HQ files them. */
export function roomPlacement(
  slugs: ReadonlyArray<string>,
  order: HqRoomOrder,
): Map<string, { section: RoomSection; position: number }> {
  const known = new Set(slugs);
  const placement = new Map<string, { section: RoomSection; position: number }>();
  for (const section of ROOM_SECTIONS) {
    for (const slug of order[section] ?? []) {
      if (known.has(slug) && !placement.has(slug)) {
        placement.set(slug, { section, position: placement.size });
      }
    }
  }
  for (const slug of slugs) {
    if (!placement.has(slug))
      placement.set(slug, { section: "permanent", position: placement.size });
  }
  return placement;
}
