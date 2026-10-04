import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  RoomsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { Rooms } from "./Rooms.ts";

/**
 * HQ fork: rooms on top of upstream's orchestrator. Replace forks a thread natively (context
 * carries over) and seats the fork in the old thread's rooms; threads an agent launches join the
 * launching thread's rooms.
 */
export class RoomThreads extends Context.Service<
  RoomThreads,
  {
    /**
     * A fresh agent takes over `threadId`: the thread is forked at its latest stable point, the
     * fork gets a handoff message (and the chosen model) and joins the old thread's rooms, and the
     * old thread settles.
     */
    readonly replace: (input: {
      readonly threadId: ThreadId;
      readonly modelSelection?: ModelSelection | undefined;
    }) => Effect.Effect<{ readonly threadId: ThreadId }, RoomsError>;
  }
>()("t3/rooms/RoomThreads") {}

const fail = (message: string) => (cause: unknown) => new RoomsError({ message, cause });

/** The launching thread and the launched one, for the ways agents start threads. */
const launchOf = (
  event: OrchestrationV2DomainEvent,
): { readonly from: ThreadId; readonly to: ThreadId } | null => {
  // t3_thread_launch and create_threads with a prompt: the first message names its sender.
  if (event.type === "message.updated" && event.payload.senderThreadId) {
    return { from: event.payload.senderThreadId, to: event.threadId };
  }
  // create_threads records the new thread on the caller's timeline.
  if (event.type === "turn-item.updated" && event.payload.type === "thread_created") {
    return { from: event.threadId, to: event.payload.targetThreadId };
  }
  return null;
};

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const rooms = yield* Rooms;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string) =>
    uuid.pipe(Effect.map((id) => CommandId.make(`server:${tag}:${id}`)));
  const openRoomsOf = (threadId: ThreadId) =>
    rooms.list.pipe(
      Effect.map((list) =>
        list.filter((room) => room.archivedAt === null && room.threadIds.includes(threadId)),
      ),
    );

  const replace = (input: {
    readonly threadId: ThreadId;
    readonly modelSelection?: ModelSelection | undefined;
  }) =>
    Effect.gen(function* () {
      const old = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(fail("Could not read the thread.")));
      if (!old) return yield* new RoomsError({ message: `There is no thread ${input.threadId}.` });
      if (old.activeRunId !== null) {
        return yield* new RoomsError({
          message: `${old.title} is still working. Stop or interrupt it, then replace it.`,
        });
      }
      if (old.latestRunId === null) {
        return yield* new RoomsError({
          message: `${old.title} has never run, so there is nothing to hand over. Start a new thread instead.`,
        });
      }
      const held = yield* openRoomsOf(old.id);
      const fork = ThreadId.make(yield* uuid);
      yield* threads
        .dispatch({
          type: "thread.fork",
          commandId: yield* commandId("replace-fork"),
          sourceThreadId: old.id,
          targetThreadId: fork,
          sourcePoint: { type: "latest_stable" },
          title: old.title,
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(fail(`Could not fork ${old.title}.`)));
      yield* Effect.forEach(
        held,
        (room) => rooms.setThread({ slug: room.slug, threadId: fork, member: true }),
        { discard: true },
      );
      const notes = held.flatMap((room) =>
        room.note?.body ? [`Room "${room.title}" note:\n${room.note.body}`] : [],
      );
      yield* threads
        .sendToThread({
          projectId: old.projectId,
          commandId: yield* commandId("replace-handoff"),
          threadId: fork,
          messageId: MessageId.make(yield* uuid),
          text: [
            `[Replace. You are a fresh agent taking over this thread's work from "${old.title}" (${old.id}), which is now settled. The conversation so far was carried over. The user started this replacement.]`,
            "Before acting, call room_context, then check git status and recent commits. Treat earlier claims as things to verify against the code.",
            ...notes,
          ].join("\n\n"),
          attachments: [],
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          mode: "auto",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(fail("The fork exists but its handoff did not start.")));
      yield* threads
        .dispatch({
          type: "thread.settle",
          commandId: yield* commandId("replace-settle"),
          threadId: old.id,
        })
        .pipe(Effect.mapError(fail("The fork started, but the old thread was not settled.")));
      return { threadId: fork };
    });

  /** Seats a thread an agent launched in the launcher's rooms, unless it already has a room. */
  const seatLaunched = (launch: { readonly from: ThreadId; readonly to: ThreadId }) =>
    Effect.gen(function* () {
      const target = yield* threads.getThreadShell(launch.to);
      // Subagents live under their parent; a message to an existing thread is not a launch.
      if (
        !target ||
        target.createdBy !== "agent" ||
        target.lineage.relationshipToParent === "subagent"
      ) {
        return;
      }
      const list = yield* rooms.list;
      if (list.some((room) => room.threadIds.includes(launch.to))) return;
      const held = list.filter(
        (room) => room.archivedAt === null && room.threadIds.includes(launch.from),
      );
      yield* Effect.forEach(
        held,
        (room) => rooms.setThread({ slug: room.slug, threadId: launch.to, member: true }),
        { discard: true },
      );
    });

  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) => {
      const launch = launchOf(event);
      return launch
        ? seatLaunched(launch).pipe(
            Effect.tapCause((cause) =>
              Effect.logWarning("could not seat a launched thread in its room", { launch, cause }),
            ),
            Effect.ignore,
          )
        : Effect.void;
    }),
  );

  return RoomThreads.of({ replace });
});

export const layer = Layer.effect(RoomThreads, make);
