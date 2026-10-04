// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as Rooms from "./Rooms.ts";

// Member threads for the shelf: one in a worktree holding cc/dex/, with a draft PR linked.
const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rooms-shelf-"));
NodeFS.mkdirSync(NodePath.join(worktree, "cc", "dex"), { recursive: true });
NodeFS.writeFileSync(NodePath.join(worktree, "cc", "dex", "plan.md"), "# Plan");
const shells = new Map([
  [
    "thread-1",
    {
      id: "thread-1",
      projectId: "project-1",
      worktreePath: worktree,
      pullRequests: [
        {
          host: "github.com",
          repository: "acme/app",
          number: 7,
          url: "https://github.com/acme/app/pull/7",
          source: "manual",
          linkedAt: "2026-10-04T00:00:00.000Z",
          snapshot: { state: "open", isDraft: true, title: "Add rooms" },
        },
        {
          host: "github.com",
          repository: "acme/app",
          number: 8,
          url: "https://github.com/acme/app/pull/8",
          source: "stack-dismissed",
          linkedAt: "2026-10-04T00:00:00.000Z",
          snapshot: null,
        },
      ],
    },
  ],
]);
const orchestrator = Layer.mergeAll(
  Layer.mock(ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed((shells.get(threadId) ?? null) as never),
  }),
  Layer.mock(ProjectService)({
    listShells: () => Effect.succeed([{ id: "project-1", workspaceRoot: "/repo" }] as never),
  }),
);

const testLayer = Rooms.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, orchestrator)),
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
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory, orchestrator)),
  ),
);

it.effect("shelves member worktree files and the PRs linked to member threads", () =>
  Effect.gen(function* () {
    const rooms = yield* Rooms.Rooms;
    yield* rooms.create({ slug: "dex", title: "Dex", outcome: "", section: "today" });
    yield* rooms.setThread({ slug: "dex", threadId: ThreadId.make("thread-1"), member: true });
    // A member the orchestrator no longer knows is skipped, not an error.
    yield* rooms.setThread({ slug: "dex", threadId: ThreadId.make("gone"), member: true });

    const shelf = yield* rooms.shelf("dex");
    // Newest first, so compare as a set: the dismissed PR stays off, the draft shows as draft.
    assert.sameDeepMembers(
      shelf.map((doc) => [doc.kind, doc.title, doc.threadId, doc.prState ?? null]),
      [
        ["pr", "Add rooms", "thread-1", "draft"],
        ["md", "plan.md", "thread-1", null],
      ],
    );
    assert.strictEqual(
      shelf.find((doc) => doc.kind === "pr")?.ref,
      "https://app.graphite.com/github/pr/acme/app/7",
    );
  }).pipe(Effect.provide(testLayer)),
);
