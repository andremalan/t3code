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
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
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
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerResult,
} from "../../../project/ProjectSetupScriptRunner.ts";
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
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-terra",
    options: [{ id: "effort", value: "high" }],
  },
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
const BUSY = ThreadId.make("thread-busy");
const threads = new Map([
  [ME, thread(ME, "Me")],
  [PEER, thread(PEER, "Peer")],
  [BUSY, { ...thread(BUSY, "Busy"), session: { status: "running" } as never }],
]);

const makeHarness = Effect.fn("makeRoomsToolkitHarness")(function* () {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const setupRuns = yield* Ref.make<ReadonlyArray<string>>([]);
  const setupResult = yield* Ref.make<ProjectSetupScriptRunnerResult>({ status: "no-script" });
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
                  {
                    id: "m1",
                    role: "assistant",
                    text: "Old news.",
                    createdAt: "t1",
                    streaming: false,
                  },
                  {
                    id: "m2",
                    role: "user",
                    text: "Keep going.",
                    createdAt: "t2",
                    streaming: false,
                  },
                  {
                    id: "m3",
                    role: "assistant",
                    text: "Shipped slice 2; slice 3 is next.",
                    createdAt: "t3",
                    streaming: false,
                  },
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
              // The vendor's default is a cheaper tier than the flagship at the top.
              models: [
                { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
                { slug: "gpt-6-astra", name: "GPT-6 Astra", isDefault: true },
              ],
            },
            {
              instanceId: "claudeAgent",
              driver: "claudeAgent",
              displayName: "Claude",
              enabled: true,
              installed: true,
              models: [
                { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
                { slug: "claude-fable-5-1", name: "Claude Fable 5.1", isDefault: true },
              ],
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
              Effect.andThen(Ref.get(setupResult)),
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
    setupResult,
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
          ref: "https://github.com/KIdentify/HQ/pull/7",
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
        const first = yield* call("room_note", {
          note: "  Status: review open.\nNext: merge.  ",
          basedOn: null,
        });
        expect(first).toMatchObject({ room: "dex", length: 33 });
        const noted = (yield* call("room_context", {})).rooms[0]!.note;
        expect(noted).toMatchObject({
          body: "Status: review open.\nNext: merge.",
          threadId: ME,
          revision: 1,
        });
        const long = yield* call("room_note", {
          note: "x".repeat(2001),
          basedOn: first.revision,
        }).pipe(Effect.flip);
        expect(long.message).toContain("at most 2000");

        // Andre edits the note from the room page, based on the version he opened.
        yield* rooms.update({ slug: "dex", note: "Edited by Andre", noteBasedOn: first.revision });
        const edited = (yield* rooms.list)[0]!.note!;
        expect(edited).toMatchObject({ body: "Edited by Andre", threadId: null, revision: 2 });
        // A thread still holding the first version is refused, and told how to recover.
        const stale = yield* call("room_note", { note: "Mine", basedOn: first.revision }).pipe(
          Effect.flip,
        );
        expect(stale.message).toContain("changed since you read it");
        expect(stale.message).toContain("retry with basedOn 2");
        const staleEdit = yield* rooms
          .update({ slug: "dex", note: "Old tab", noteBasedOn: null })
          .pipe(Effect.flip);
        expect(staleEdit.message).toContain("changed since you read it");
        expect((yield* rooms.list)[0]!.note?.body).toBe("Edited by Andre");

        // Clearing keeps counting, so a writer holding an old revision cannot slip in after it.
        const cleared = yield* call("room_note", { note: "", basedOn: edited.revision });
        expect(cleared.revision).toBe(3);
        expect((yield* rooms.list)[0]!.note).toMatchObject({ body: "", revision: 3 });
        const afterClear = yield* call("room_note", { note: "Late", basedOn: 1 }).pipe(Effect.flip);
        expect(afterClear.message).toContain("retry with basedOn 3");
        const unversioned = yield* rooms
          .update({ slug: "dex", note: "No version" })
          .pipe(Effect.flip);
        expect(unversioned.message).toContain("needs noteBasedOn");

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
        yield* rooms.setNote({
          slug: "dex",
          body: "Slice 3 is next.",
          threadId: ME,
          basedOn: null,
        });

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
        // Another provider without a model gets its flagship, not its default tier.
        expect(elsewhereCreate).toMatchObject({
          projectId: "project-2",
          modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        });
        yield* Ref.set(commands, []);
        yield* call("start_thread", {
          prompt: "Review.",
          title: "Same provider",
          provider: "codex",
        });
        const [sameCreate] = yield* Ref.get(commands);
        // The caller's own provider keeps the caller's model and options.
        expect(sameCreate).toMatchObject({ modelSelection: thread(ME, "Me").modelSelection });
        const unknown = yield* call("start_thread", {
          prompt: "x",
          title: "x",
          provider: "codex",
          model: "gpt-9",
        }).pipe(Effect.flip);
        expect(unknown.message).toContain("codex (gpt-6.1-sol, gpt-6-astra)");

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

  it.effect(
    "refuses before creating anything, waits for blocking setup, and keeps working threads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { call, commands, rooms, setupRuns, setupResult, launcher } = yield* makeHarness();
          yield* rooms.create({ slug: "dex", title: "Dex", outcome: "", section: "today" });
          yield* rooms.setThread({ slug: "dex", threadId: ME, member: true });

          const badModel = yield* call("start_thread", {
            prompt: "x",
            title: "x",
            worktree: "new",
            model: "gpt-9",
          }).pipe(Effect.flip);
          expect(badModel.message).toContain("No installed provider model");
          const badRoom = yield* call("start_thread", {
            prompt: "x",
            title: "x",
            room: "nope",
          }).pipe(Effect.flip);
          expect(badRoom.message).toContain("no open room called nope");
          expect(yield* Ref.get(commands)).toEqual([]);
          expect(yield* Ref.get(setupRuns)).toEqual([]);

          const setupDone = yield* Deferred.make<void>();
          yield* Ref.set(setupResult, {
            status: "started",
            scriptId: "setup",
            scriptName: "Setup",
            scriptCommand: "vp i",
            terminalId: "setup",
            cwd: "/worktrees/x",
            async: false,
            completion: Deferred.await(setupDone).pipe(Effect.as({ exitCode: 0, durationMs: 1 })),
          });
          const waiting = yield* call("start_thread", {
            prompt: "Build it.",
            title: "Builder",
            worktree: "new",
          });
          expect(waiting.firstTurn).toBe("after-setup");
          expect((yield* Ref.get(commands)).map((command) => command.type)).toEqual([
            "thread.create",
          ]);
          yield* Deferred.succeed(setupDone, undefined);
          // The first turn is dispatched by a background fiber once setup finishes.
          while ((yield* Ref.get(commands)).length < 2) yield* Effect.yieldNow;
          expect((yield* Ref.get(commands)).map((command) => command.type)).toEqual([
            "thread.create",
            "thread.turn.start",
          ]);

          yield* Ref.set(commands, []);
          const busy = yield* launcher.replace({ threadId: BUSY }).pipe(Effect.flip);
          expect(busy.message).toContain("Busy is still working");
          expect(yield* Ref.get(commands)).toEqual([]);
        }),
      ),
  );

  it.effect("reads threads, waits for them to go idle, and settles them when their turn ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call, commands } = yield* makeHarness();
        const busy = threads.get(BUSY)!;

        const newer = yield* call("thread_read", { threadId: PEER, after: "m1", limit: 1 });
        expect(newer).toMatchObject({ title: "Peer", working: false });
        expect(newer.messages.map((message) => message.id)).toEqual(["m3"]);

        // Waiting returns once the thread stops working; the 5s recheck notices without an event.
        const reading = yield* call("thread_read", { threadId: BUSY, waitSeconds: 30 }).pipe(
          Effect.forkChild,
        );
        threads.set(BUSY, { ...busy, session: { status: "ready" } as never });
        yield* TestClock.adjust("5 seconds");
        expect((yield* Fiber.join(reading)).working).toBe(false);
        threads.set(BUSY, busy);
        const stillBusy = yield* call("thread_read", { threadId: BUSY, waitSeconds: 10 }).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("10 seconds");
        expect((yield* Fiber.join(stillBusy)).working).toBe(true);

        expect(yield* call("thread_settle", { threadId: PEER })).toMatchObject({
          state: "settled",
          when: "now",
        });
        expect(yield* call("thread_settle", { threadId: PEER, archive: true })).toMatchObject({
          state: "archived",
          when: "now",
        });
        expect((yield* Ref.get(commands)).map((command) => command.type)).toEqual([
          "thread.settle",
          "thread.archive",
        ]);

        // A working thread (as a thread settling itself always is) settles when its turn ends.
        yield* Ref.set(commands, []);
        expect(yield* call("thread_settle", { threadId: BUSY })).toMatchObject({
          when: "after-turn",
        });
        expect(yield* Ref.get(commands)).toEqual([]);
        threads.set(BUSY, { ...busy, session: { status: "ready" } as never });
        yield* TestClock.adjust("5 seconds");
        while ((yield* Ref.get(commands)).length === 0) yield* Effect.yieldNow;
        expect(yield* Ref.get(commands)).toMatchObject([{ type: "thread.settle", threadId: BUSY }]);
        threads.set(BUSY, busy);

        yield* Ref.set(commands, []);
        yield* call("start_thread", {
          prompt: "Review it.",
          title: "Reviewer",
          settleWhenDone: true,
        });
        const turn = (yield* Ref.get(commands)).find(
          (command) => command.type === "thread.turn.start",
        );
        const text = turn?.type === "thread.turn.start" ? turn.message.text : "";
        expect(text).toContain("Review it.");
        expect(text).toMatch(/call thread_settle with no threadId/);
      }),
    ),
  );
});
