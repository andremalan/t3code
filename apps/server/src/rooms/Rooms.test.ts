// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Rooms from "./Rooms.ts";

const testLayer = Rooms.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const order = (rooms: ReadonlyArray<{ slug: string; section: string }>) =>
  rooms.map((room) => `${room.section}:${room.slug}`);

it.effect("orders, archives and fills rooms", () =>
  Effect.gen(function* () {
    const rooms = yield* Rooms.Rooms;
    yield* rooms.create({ slug: "a", title: "A", outcome: "", section: "today" });
    yield* rooms.create({ slug: "b", title: "B", outcome: "", section: "backlog" });
    yield* rooms.create({ slug: "c", title: "C", outcome: "Ship it", section: "today" });

    const duplicate = yield* Effect.flip(
      rooms.create({ slug: "a", title: "Again", outcome: "", section: "today" }),
    );
    assert.include(duplicate.message, "already exists");

    yield* rooms.reorder({ today: ["c"], permanent: ["b"], backlog: [] });
    yield* rooms.setThread({ slug: "c", threadId: ThreadId.make("t1"), member: true });
    yield* rooms.setThread({ slug: "c", threadId: ThreadId.make("t2"), member: true });
    yield* rooms.setThread({ slug: "c", threadId: ThreadId.make("t1"), member: false });
    const archived = yield* rooms.update({ slug: "a", archived: true, title: "Renamed" });
    assert.isNotNull(archived.archivedAt);
    assert.strictEqual(archived.title, "Renamed");

    const [current] = yield* rooms.stream.pipe(Stream.take(1), Stream.runCollect);
    // "a" keeps its position: it was left out of the reorder.
    assert.deepStrictEqual(order(current!), ["today:a", "today:c", "permanent:b"]);
    assert.deepStrictEqual(current!.find((room) => room.slug === "c")!.threadIds, [
      ThreadId.make("t2"),
    ]);

    const unarchived = yield* rooms.update({ slug: "a", archived: false });
    assert.isNull(unarchived.archivedAt);
    const archivedDuplicate = yield* rooms
      .update({ slug: "a", archived: true })
      .pipe(
        Effect.andThen(
          Effect.flip(rooms.create({ slug: "a", title: "A", outcome: "", section: "today" })),
        ),
      );
    assert.include(archivedDuplicate.message, "archived room");

    const missing = yield* Effect.flip(
      rooms.setThread({ slug: "nope", threadId: ThreadId.make("t1"), member: true }),
    );
    assert.include(missing.message, "no room called nope");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("imports HQ rooms and shelves, resolving members to live T3 threads", () =>
  Effect.gen(function* () {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hq-import-"));
    NodeFS.mkdirSync(NodePath.join(stateDir, "config"));
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "config", "ROOM-ORDER.json"),
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      JSON.stringify({ today: ["dex"], permanent: [], backlog: ["old"] }),
    );
    const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hq-worktree-"));
    NodeFS.mkdirSync(NodePath.join(worktree, "cc", "dex", "shots"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(worktree, "cc", "dex", "notes.md"), "# Notes");
    NodeFS.writeFileSync(NodePath.join(worktree, "cc", "dex", "shots", "a.png"), "");
    NodeFS.writeFileSync(NodePath.join(worktree, "cc", "dex", ".hidden"), "");
    const hq = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "hq.sqlite"));
    hq.exec(`
      CREATE TABLE rooms (id TEXT, slug TEXT, title TEXT, created_at TEXT, archived_at TEXT);
      CREATE TABLE room_work (room_id TEXT, outcome TEXT);
      CREATE TABLE room_members (room_id TEXT, session_uuid TEXT, attached_at TEXT);
      CREATE TABLE room_documents (
        room_id TEXT, title TEXT, ref TEXT, kind TEXT, author_id TEXT, created_at TEXT
      );
      INSERT INTO rooms VALUES
        ('1', 'dex', 'Dex', '2026-01-01', NULL),
        ('2', 'old', 'Old', '2026-01-02', '2026-02-01'),
        ('3', 'loose', 'Loose', '2026-01-03', NULL);
      INSERT INTO room_work VALUES ('1', 'Ship Dex');
      INSERT INTO room_members VALUES
        ('1', 'claude-session', '2026-01-05'),
        ('1', 'codex-session', '2026-01-05'),
        ('1', 'cmux-session', '2026-01-05'),
        ('2', 'deleted-session', '2026-01-05');
      INSERT INTO room_documents VALUES
        ('1', 'Old title', 'https://github.com/KIdentify/HQ/pull/7', 'pr', 'codex-session', '2026-01-06'),
        ('1', 'gone.md', '/nonexistent/gone.md', 'md', 'claude-session', '2026-01-06'),
        ('1', 'Notes', '${worktree}/cc/dex/notes.md', 'md', '', '2000-01-01');
    `);
    hq.close();

    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, deleted_at)
      VALUES
        ('thread-claude', 'p', 'Claude', '2026-01-01', '2026-01-01', NULL),
        ('thread-codex', 'p', 'Codex', '2026-01-01', '2026-01-01', NULL),
        ('thread-deleted', 'p', 'Gone', '2026-01-01', '2026-01-01', '2026-01-09')
    `;
    yield* sql`UPDATE projection_threads SET worktree_path = ${worktree} WHERE thread_id = 'thread-claude'`;
    yield* sql`
      INSERT INTO projection_thread_pull_requests
        (thread_id, host, repository, number, url, source, linked_at, snapshot_json)
      VALUES ('thread-codex', 'github.com', 'kidentify/hq', 7,
        'https://github.com/kidentify/hq/pull/7', 'agent', '2026-01-07',
        '{"state":"open","isDraft":true,"title":"Live title"}')
    `;
    yield* sql`
      INSERT INTO provider_session_runtime
        (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json)
      VALUES
        ('thread-claude', 'claudeAgent', 'claude', 'ready', '2026-01-01', '{"resume":"claude-session"}'),
        ('thread-codex', 'codex', 'codex', 'ready', '2026-01-01', '{"threadId":"codex-session"}'),
        ('thread-deleted', 'codex', 'codex', 'ready', '2026-01-01', '{"threadId":"deleted-session"}')
    `;

    const first = yield* Rooms.importHqRooms(stateDir);
    assert.deepStrictEqual(first, { rooms: 3, threads: 2, skippedMembers: 2, documents: 1 });
    const again = yield* Rooms.importHqRooms(stateDir);
    assert.deepStrictEqual(again, { rooms: 0, threads: 0, skippedMembers: 2, documents: 0 });

    const rooms = yield* Rooms.Rooms;
    const [current] = yield* rooms.stream.pipe(Stream.take(1), Stream.runCollect);
    assert.deepStrictEqual(order(current!), ["today:dex", "permanent:loose", "backlog:old"]);
    const dex = current!.find((room) => room.slug === "dex")!;
    assert.strictEqual(dex.outcome, "Ship Dex");
    assert.deepStrictEqual([...dex.threadIds].toSorted(), ["thread-claude", "thread-codex"]);
    assert.isNotNull(current!.find((room) => room.slug === "old")!.archivedAt);

    // Recorded and scanned entries merge by ref; the recorded PR and missing file are dropped and
    // the PR comes from its thread link.
    const shelf = yield* rooms.shelf("dex");
    assert.deepStrictEqual(
      shelf.map(({ ref, title, kind, threadId, prState }) => ({
        ref,
        title,
        kind,
        threadId,
        prState,
      })),
      [
        {
          ref: `${worktree}/cc/dex/shots/a.png`,
          title: "shots/a.png",
          kind: "png",
          threadId: ThreadId.make("thread-claude"),
          prState: undefined,
        },
        {
          ref: "https://app.graphite.com/github/pr/kidentify/hq/7",
          title: "Live title",
          kind: "pr",
          threadId: ThreadId.make("thread-codex"),
          prState: "draft",
        },
        {
          ref: `${worktree}/cc/dex/notes.md`,
          title: "Notes",
          kind: "md",
          threadId: ThreadId.make("thread-claude"),
          prState: undefined,
        },
      ],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("adds note revisions to a notes table written before they existed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE hq_rooms (
        slug TEXT PRIMARY KEY, title TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT '',
        section TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL, archived_at TEXT
      )
    `;
    yield* sql`
      CREATE TABLE hq_room_notes (
        room_slug TEXT PRIMARY KEY, body TEXT NOT NULL, thread_id TEXT, updated_at TEXT NOT NULL
      ) WITHOUT ROWID
    `;
    yield* sql`INSERT INTO hq_rooms VALUES ('dex', 'Dex', '', 'today', 0, '2026-10-01T00:00:00.000Z', NULL)`;
    yield* sql`INSERT INTO hq_room_notes VALUES ('dex', 'Old note', NULL, '2026-10-01T00:00:00.000Z')`;

    const rooms = yield* Rooms.Rooms.pipe(Effect.provide(Rooms.layer));
    const [dex] = yield* rooms.list;
    assert.deepStrictEqual(dex?.note, {
      body: "Old note",
      threadId: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
      revision: 1,
    });
    const next = yield* rooms.setNote({
      slug: "dex",
      body: "New note",
      threadId: null,
      basedOn: 1,
    });
    assert.strictEqual(next.note?.revision, 2);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory))),
);
