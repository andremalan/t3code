import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as Rooms from "./Rooms.ts";
import * as RoomThreads from "./RoomThreads.ts";

const OLD = ThreadId.make("thread-old");
const BUSY = ThreadId.make("thread-busy");
const FRESH = ThreadId.make("thread-fresh");
const LAUNCHER = ThreadId.make("thread-launcher");
const LAUNCHED = ThreadId.make("thread-launched");
const SUBAGENT = ThreadId.make("thread-subagent");
const EXISTING = ThreadId.make("thread-existing");

const shell = (id: ThreadId, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: "project-1",
  title: id,
  activeRunId: null,
  latestRunId: "run-1",
  createdBy: "user",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  ...extra,
});
const threads = new Map<string, ReturnType<typeof shell>>([
  [OLD, shell(OLD)],
  [BUSY, shell(BUSY, { activeRunId: "run-2" })],
  [FRESH, shell(FRESH, { latestRunId: null })],
  [LAUNCHER, shell(LAUNCHER)],
  [LAUNCHED, shell(LAUNCHED, { createdBy: "agent" })],
  [EXISTING, shell(EXISTING, { createdBy: "agent" })],
  [
    SUBAGENT,
    shell(SUBAGENT, {
      createdBy: "agent",
      lineage: {
        parentThreadId: LAUNCHER,
        relationshipToParent: "subagent",
        rootThreadId: LAUNCHER,
      },
    }),
  ],
]);

const makeHarness = Effect.fn("makeRoomThreadsHarness")(function* () {
  const commands = yield* Ref.make<ReadonlyArray<{ readonly type: string } & object>>([]);
  const events = yield* Queue.unbounded<unknown>();
  const record = (command: { readonly type: string } & object) =>
    Ref.update(commands, (all) => [...all, command]);
  const dependencies = RoomThreads.layer.pipe(
    Layer.provideMerge(Rooms.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed((threads.get(threadId) ?? null) as never),
          dispatch: (command) => record(command).pipe(Effect.as({} as never)),
          sendToThread: (input) => record({ type: "send", ...input }).pipe(Effect.as({} as never)),
          streamDomainEvents: Stream.fromQueue(events) as never,
        }),
        Layer.mock(ProjectService)({ listShells: () => Effect.succeed([]) }),
        NodeServices.layer,
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const context = yield* Layer.build(dependencies);
  return {
    commands,
    events,
    rooms: Context.get(context, Rooms.Rooms),
    roomThreads: Context.get(context, RoomThreads.RoomThreads),
  };
});

describe("RoomThreads", () => {
  it.effect("replace forks the thread into its rooms with a handoff and settles the old one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, rooms, roomThreads } = yield* makeHarness();
        yield* rooms.create({ slug: "dex", title: "Dex", outcome: "", section: "today" });
        yield* rooms.setThread({ slug: "dex", threadId: OLD, member: true });
        yield* rooms.setNote({
          slug: "dex",
          body: "Slice 3 is next.",
          threadId: null,
          basedOn: null,
        });

        const busy = yield* roomThreads.replace({ threadId: BUSY }).pipe(Effect.flip);
        expect(busy.message).toContain("still working");
        const fresh = yield* roomThreads.replace({ threadId: FRESH }).pipe(Effect.flip);
        expect(fresh.message).toContain("never run");
        expect(yield* Ref.get(commands)).toEqual([]);

        const model = { instanceId: "codex", model: "gpt-6.1-sol" } as never;
        const { threadId } = yield* roomThreads.replace({ threadId: OLD, modelSelection: model });
        const [fork, send, settle] = yield* Ref.get(commands);
        expect(fork).toMatchObject({
          type: "thread.fork",
          sourceThreadId: OLD,
          targetThreadId: threadId,
          sourcePoint: { type: "latest_stable" },
        });
        expect(send).toMatchObject({ type: "send", threadId, modelSelection: model });
        expect((send as unknown as { text: string }).text).toContain("Slice 3 is next.");
        expect(settle).toMatchObject({ type: "thread.settle", threadId: OLD });
        expect((yield* rooms.list)[0]!.threadIds.toSorted()).toEqual([OLD, threadId].toSorted());
      }),
    ),
  );

  it.effect("seats threads an agent launches in the launcher's rooms, but not subagents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, rooms } = yield* makeHarness();
        yield* rooms.create({ slug: "dex", title: "Dex", outcome: "", section: "today" });
        yield* rooms.setThread({ slug: "dex", threadId: LAUNCHER, member: true });

        const created = (threadId: ThreadId) => ({
          type: "thread.created",
          threadId,
          payload: { createdBy: "agent" },
        });
        const message = (threadId: ThreadId) => ({
          type: "message.updated",
          threadId,
          payload: { senderThreadId: LAUNCHER },
        });
        // A later message to an existing agent-made thread is not a launch.
        yield* Queue.offer(events, message(EXISTING));
        // A subagent's first message names its parent too; it stays out of the room.
        yield* Queue.offer(events, created(SUBAGENT));
        yield* Queue.offer(events, message(SUBAGENT));
        // t3_thread_launch: the launched thread's first message names the launcher.
        yield* Queue.offer(events, created(LAUNCHED));
        yield* Queue.offer(events, message(LAUNCHED));
        const seated = () =>
          rooms.list.pipe(Effect.map((list) => list[0]!.threadIds.includes(LAUNCHED)));
        while (!(yield* seated())) yield* Effect.yieldNow;
        expect((yield* rooms.list)[0]!.threadIds.toSorted()).toEqual(
          [LAUNCHER, LAUNCHED].toSorted(),
        );
      }),
    ),
  );
});
