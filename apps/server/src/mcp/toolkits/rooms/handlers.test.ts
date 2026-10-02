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

import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProjectSetupScriptRunner } from "../../../project/ProjectSetupScriptRunner.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import * as Rooms from "../../../rooms/Rooms.ts";
import * as ThreadLauncher from "../../../rooms/ThreadLauncher.ts";
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
  const setupRuns = yield* Ref.make<ReadonlyArray<string>>([]);
  const dependencies = ThreadLauncher.layer.pipe(
    Layer.provideMerge(Rooms.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: (threadId) =>
            Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getProjectShells: () =>
            Effect.succeed([
              { id: ProjectId.make("project-1"), title: "hq", workspaceRoot: "/repo" },
              { id: ProjectId.make("project-2"), title: "Dex", workspaceRoot: "/code/dex-app" },
            ] as never),
          getThreadDetailById: () =>
            Effect.succeed(
              Option.some({
                messages: [
                  { role: "assistant", text: "Old news." },
                  { role: "user", text: "Keep going." },
                  { role: "assistant", text: "Shipped slice 2; slice 3 is next." },
                ],
              } as never),
            ),
        }),
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId: "codex",
              driver: "codex",
              enabled: true,
              installed: true,
              models: [
                { slug: "gpt-5", name: "GPT-5", isDefault: true },
                { slug: "gpt-5-codex", name: "GPT-5 Codex" },
              ],
            },
            {
              instanceId: "claudeAgent",
              driver: "claudeAgent",
              displayName: "Claude",
              enabled: true,
              installed: true,
              models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", isDefault: true }],
            },
          ] as never),
        }),
        Layer.mock(GitWorkflowService)({
          createWorktree: (input) =>
            Effect.succeed({
              worktree: { path: `/worktrees/${input.newRefName}`, refName: input.newRefName! },
            }),
        }),
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: (input) =>
            Ref.update(setupRuns, (runs) => [...runs, input.worktreePath]).pipe(
              Effect.as({ status: "no-script" as const }),
            ),
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
  return {
    commands,
    call,
    rooms,
    setupRuns,
    launcher: Context.get(context, ThreadLauncher.ThreadLauncher),
  };
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

        expect(context.rooms[0]!.note).toBeNull();
        expect(
          yield* call("room_note", { note: "  Status: review open.\nNext: merge.  " }),
        ).toEqual({
          room: "dex",
          length: 33,
        });
        const noted = (yield* call("room_context", {})).rooms[0]!.note;
        expect(noted).toMatchObject({ body: "Status: review open.\nNext: merge.", threadId: ME });
        const long = yield* call("room_note", { note: "x".repeat(2001) }).pipe(Effect.flip);
        expect(long.message).toContain("at most 2000");
        yield* rooms.update({ slug: "dex", note: "Edited by a user" });
        expect((yield* rooms.list)[0]!.note).toMatchObject({
          body: "Edited by a user",
          threadId: null,
        });
        yield* call("room_note", { note: "" });
        expect((yield* rooms.list)[0]!.note).toBeNull();

        expect(yield* call("room_move", { room: "other" })).toEqual({
          threadId: ME,
          room: "other",
        });
        const moved = (yield* rooms.list).map((room) => [room.slug, room.threadIds]);
        expect(moved).toEqual([
          ["dex", [PEER]],
          ["other", [ME]],
        ]);
        yield* call("room_move", { room: null, threadId: PEER });
        expect((yield* rooms.list).flatMap((room) => room.threadIds)).toEqual([ME]);
        const ghost = yield* call("room_move", { room: "dex", threadId: "nope" }).pipe(Effect.flip);
        expect(ghost.message).toContain("no thread");
      }),
    ),
  );

  it.effect("starts threads in the caller's room and replaces a thread with a handoff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call, commands, rooms, setupRuns, launcher } = yield* makeHarness();
        yield* rooms.create({ slug: "dex", title: "Dex", outcome: "", section: "today" });
        yield* rooms.setThread({ slug: "dex", threadId: ME, member: true });
        yield* rooms.setThread({ slug: "dex", threadId: PEER, member: true });
        yield* rooms.setNote({ slug: "dex", body: "Slice 3 is next.", threadId: ME });

        const started = yield* call("start_thread", {
          prompt: "Build slice 3.",
          title: "Slice 3",
          worktree: "new",
          branch: "feat/slice-3",
        });
        expect(started).toMatchObject({
          title: "Slice 3",
          worktreePath: "/worktrees/feat/slice-3",
          branch: "feat/slice-3",
          rooms: ["dex"],
        });
        expect(yield* Ref.get(setupRuns)).toEqual(["/worktrees/feat/slice-3"]);
        const [create, turn] = yield* Ref.get(commands);
        expect(create).toMatchObject({
          type: "thread.create",
          threadId: started.threadId,
          worktreePath: "/worktrees/feat/slice-3",
          runtimeMode: "approval-required",
        });
        const firstText = turn?.type === "thread.turn.start" ? turn.message.text : "";
        expect(firstText).toContain(`Started by thread "Me" (${ME})`);
        expect(firstText).toMatch(/Build slice 3\.$/);
        expect((yield* rooms.list)[0]!.threadIds).toContain(started.threadId);

        const alone = yield* call("start_thread", { prompt: "Look.", title: "Solo", room: null });
        expect(alone).toMatchObject({ worktreePath: worktree, rooms: [] });

        yield* Ref.set(commands, []);
        const elsewhere = yield* call("start_thread", {
          prompt: "Review the API.",
          title: "Dex review",
          project: "dex-app",
          provider: "Claude",
        });
        expect(elsewhere).toMatchObject({ worktreePath: null, branch: null });
        const [elsewhereCreate] = yield* Ref.get(commands);
        expect(elsewhereCreate).toMatchObject({
          projectId: "project-2",
          modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        });
        const unknown = yield* call("start_thread", {
          prompt: "x",
          title: "x",
          provider: "codex",
          model: "gpt-9",
        }).pipe(Effect.flip);
        expect(unknown.message).toContain("codex (gpt-5, gpt-5-codex)");

        yield* Ref.set(commands, []);
        const replacement = yield* launcher.replace({ threadId: PEER });
        expect(replacement).toMatchObject({
          title: "Peer",
          worktreePath: worktree,
          rooms: ["dex"],
        });
        const replaced = yield* Ref.get(commands);
        expect(replaced.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.turn.start",
          "thread.settle",
        ]);
        const handoff = replaced[1]?.type === "thread.turn.start" ? replaced[1].message.text : "";
        expect(handoff).toContain(`taking over from thread "Peer" (${PEER})`);
        expect(handoff).toContain("Slice 3 is next.");
        expect(handoff).toContain("Shipped slice 2; slice 3 is next.");
        expect(handoff).not.toContain("Old news.");
        expect(replaced[2]).toMatchObject({ threadId: PEER });
      }),
    ),
  );
});
