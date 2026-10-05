// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import * as Rooms from "../../../rooms/Rooms.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { RoomsToolkitHandlersLive } from "./handlers.ts";
import { RoomsToolkit } from "./tools.ts";

const ME = ThreadId.make("thread-me");
const PEER = ThreadId.make("thread-peer");
const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rooms-toolkit-"));
NodeFS.writeFileSync(NodePath.join(worktree, "report.md"), "# Report");

const at = (iso: string) => DateTime.makeUnsafe(iso);
const shell = (id: ThreadId, title: string) => ({
  id,
  projectId: "project-1",
  title,
  // The caller holds an active run, as upstream's mutation check requires.
  providerInstanceId: "codex",
  activeRunId: "run-1",
  worktreePath: worktree,
  status: "idle",
  settledOverride: null,
  archivedAt: null,
  deletedAt: null,
  latestRunRequestedAt: at("2026-10-04T10:00:00.000Z"),
  latestRunCompletedAt: at("2026-10-04T10:05:00.000Z"),
  updatedAt: at("2026-10-04T10:05:00.000Z"),
  pullRequests: [],
});
const threads = new Map([
  [ME, shell(ME, "Me")],
  [PEER, shell(PEER, "Peer")],
]);

const makeHarness = Effect.fn("makeRoomsToolkitHarness")(function* () {
  const dependencies = Rooms.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed((threads.get(threadId) ?? null) as never),
          streamDomainEvents: Stream.empty,
        }),
        Layer.mock(ProjectService)({
          getShell: () => Effect.succeed(Option.none()),
          listShells: () => Effect.succeed([]),
        }),
        ServerConfig.layerTest(worktree, { prefix: "rooms-toolkit-home-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const context = yield* Layer.build(dependencies);
  const rooms = Context.get(context, Rooms.Rooms);
  const toolkit = yield* RoomsToolkit.pipe(
    Effect.provide(RoomsToolkitHandlersLive.pipe(Layer.provide(Layer.succeedContext(context)))),
  );
  const call = <Name extends keyof typeof RoomsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof RoomsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ME,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
        issuedAt: 1,
      }),
      Effect.provideContext(context),
    );
  return { call, rooms };
});

describe("rooms toolkit handlers", () => {
  it.effect("reads the caller's room, shelves files, keeps the note and moves threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call, rooms } = yield* makeHarness();
        yield* rooms.create({ slug: "dex", title: "Dex", outcome: "Ship Dex", section: "today" });
        yield* rooms.create({ slug: "other", title: "Other", outcome: "", section: "today" });

        const homeless = yield* call("shelf_add", { ref: "report.md" }).pipe(Effect.flip);
        expect(homeless.message).toContain("not in a room");

        yield* rooms.setThread({ slug: "dex", threadId: ME, member: true });
        yield* rooms.setThread({ slug: "dex", threadId: PEER, member: true });

        // Relative paths resolve against the caller's worktree; the shelf keeps a copy.
        const shelved = yield* call("shelf_add", { ref: "report.md" });
        expect(shelved).toEqual({
          room: "dex",
          ref: `${rooms.shelfDir("dex")}/report.md`,
          title: "report.md",
          kind: "md",
        });
        expect(NodeFS.readFileSync(shelved.ref, "utf8")).toBe("# Report");
        const missing = yield* call("shelf_add", { ref: "nope.md" }).pipe(Effect.flip);
        expect(missing.message).toContain("no file");

        const context = yield* call("room_context", {});
        expect(context.otherRooms).toEqual([{ slug: "other", title: "Other" }]);
        expect(context.rooms[0]).toMatchObject({ slug: "dex", outcome: "Ship Dex", note: null });
        expect(context.rooms[0]!.threads).toEqual([
          {
            threadId: ME,
            title: "Me",
            you: true,
            status: "idle",
            settled: false,
            lastActivityAt: "2026-10-04T10:05:00.000Z",
          },
          expect.objectContaining({ threadId: PEER, you: false }),
        ]);
        expect(context.rooms[0]!.shelf.total).toBe(1);
        expect(context.rooms[0]!.shelfDir).toBe(rooms.shelfDir("dex"));

        const first = yield* call("room_note", { note: "Next: merge.", basedOn: null });
        expect(first).toEqual({ room: "dex", length: 12, revision: 1 });
        const stale = yield* call("room_note", { note: "Mine", basedOn: null }).pipe(Effect.flip);
        expect(stale.message).toContain("retry with basedOn 1");

        expect(yield* call("room_move", { room: "other" })).toEqual({
          threadId: ME,
          room: "other",
        });
        expect((yield* rooms.list).map((room) => [room.slug, room.threadIds])).toEqual([
          ["dex", [PEER]],
          ["other", [ME]],
        ]);
        const ghost = yield* call("room_move", { room: "dex", threadId: "nope" }).pipe(Effect.flip);
        expect(ghost.message).toContain("no thread");
      }),
    ),
  );
});
