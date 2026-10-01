// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as Rooms from "../../../rooms/Rooms.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { RoomsToolkitHandlersLive } from "./handlers.ts";
import { RoomsToolkit } from "./tools.ts";

const ME = ThreadId.make("thread-me");
const PEER = ThreadId.make("thread-peer");
const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rooms-toolkit-"));
NodeFS.writeFileSync(NodePath.join(worktree, "report.md"), "# Report");

const thread = (id: ThreadId, title: string): OrchestrationThreadShell => ({
  id,
  projectId: ProjectId.make("project-1"),
  title,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "plan",
  branch: null,
  worktreePath: worktree,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});
const threads = new Map([
  [ME, thread(ME, "Me")],
  [PEER, thread(PEER, "Peer")],
]);

const makeHarness = Effect.fn("makeRoomsToolkitHarness")(function* () {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const dependencies = Rooms.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: (threadId) =>
            Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
          getProjectShellById: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(OrchestrationEngineService)({
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Ref.update(commands, (recorded) => [...recorded, command]).pipe(
              Effect.as({ sequence: 1 }),
            ),
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
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
        capabilities: new Set<McpInvocationContext.McpCapability>(["pull-requests"]),
        issuedAt: 1,
      }),
      Effect.provideContext(context),
    );
  return { commands, call, rooms };
});

describe("rooms toolkit handlers", () => {
  it.effect("shelves, reads and messages within the caller's room", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call, commands, rooms } = yield* makeHarness();
        yield* rooms.create({ slug: "dex", title: "Dex", outcome: "Ship Dex", section: "today" });
        yield* rooms.create({ slug: "other", title: "Other", outcome: "", section: "today" });

        const homeless = yield* call("shelf_add", { ref: "report.md" }).pipe(Effect.flip);
        expect(homeless.message).toContain("not in a room");

        yield* rooms.setThread({ slug: "dex", threadId: ME, member: true });
        yield* rooms.setThread({ slug: "dex", threadId: PEER, member: true });

        expect(yield* call("shelf_add", { ref: "report.md" })).toEqual({
          room: "dex",
          ref: `${worktree}/report.md`,
          title: "report.md",
          kind: "md",
        });
        const missing = yield* call("shelf_add", { ref: "nope.md" }).pipe(Effect.flip);
        expect(missing.message).toContain("no file");
        const pullRequest = yield* call("shelf_add", {
          ref: "https://github.com/acme/app/pull/7",
        }).pipe(Effect.flip);
        expect(pullRequest.message).toContain("link_pull_request");
        expect(yield* call("shelf_add", { ref: "https://example.com/spec" })).toMatchObject({
          title: "https://example.com/spec",
          kind: "link",
        });

        const context = yield* call("room_context", {});
        expect(context.otherRooms).toEqual([{ slug: "other", title: "Other" }]);
        expect(context.rooms).toHaveLength(1);
        expect(context.rooms[0]).toMatchObject({ slug: "dex", outcome: "Ship Dex" });
        expect(context.rooms[0]!.threads.map((each) => [each.title, each.you])).toEqual([
          ["Me", true],
          ["Peer", false],
        ]);
        expect(context.rooms[0]!.shelf.total).toBe(2);

        const self = yield* call("send_to_thread", { threadId: ME, message: "hi" }).pipe(
          Effect.flip,
        );
        expect(self.message).toContain("this thread");
        expect(yield* call("send_to_thread", { threadId: PEER, message: "Review #7" })).toEqual({
          threadId: PEER,
          title: "Peer",
        });
        const [sent] = yield* Ref.get(commands);
        expect(sent).toMatchObject({
          type: "thread.turn.start",
          threadId: PEER,
          runtimeMode: "approval-required",
          interactionMode: "plan",
        });
        const text = sent?.type === "thread.turn.start" ? sent.message.text : "";
        expect(text).toContain(`"Me" (${ME})`);
        expect(text).toMatch(/Review #7$/);
      }),
    ),
  );
});
