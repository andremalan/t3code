import {
  CommandId,
  MessageId,
  type OrchestrationThreadShell,
  type Room,
  RoomsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as Rooms from "../../../rooms/Rooms.ts";
import * as ThreadLauncher from "../../../rooms/ThreadLauncher.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { type RoomContextResult, RoomsToolkit } from "./tools.ts";

const RECENT_SHELF = 25;

const failWith = (message: string) => (cause: unknown) => new RoomsError({ message, cause });

/** The first message of a thread another thread started. */
export function startedByText(
  sender: Pick<OrchestrationThreadShell, "id" | "title">,
  prompt: string,
): string {
  return `[Started by thread "${sender.title}" (${sender.id}) via start_thread. A peer agent, not the user. Report back with send_to_thread when it asks for an answer.]\n\n${prompt}`;
}

/** The framing a peer message arrives with, so the receiving agent does not take it for the user. */
export function peerMessageText(
  sender: Pick<OrchestrationThreadShell, "id" | "title">,
  message: string,
): string {
  return `[Message from thread "${sender.title}" (${sender.id}) via send_to_thread. A peer agent, not the user. Reply with send_to_thread if it needs an answer.]\n\n${message}`;
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const rooms = yield* Rooms.Rooms;
  const launcher = yield* ThreadLauncher.ThreadLauncher;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const caller = McpInvocationContext.McpInvocationContext;

  const threadShell = (threadId: ThreadId) =>
    snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrNull), Effect.mapError(failWith("Could not read threads.")));

  const openRooms = rooms.list.pipe(
    Effect.map((list) => list.filter((room) => room.archivedAt === null)),
  );

  /** The named room, else the one open room holding the caller. */
  const resolveRoom = Effect.fn("RoomsToolkit.resolveRoom")(function* (
    slug: string | undefined,
    threadId: ThreadId,
  ) {
    const list = yield* rooms.list;
    if (slug !== undefined) {
      const room = list.find((each) => each.slug === slug);
      if (!room) return yield* new RoomsError({ message: `There is no room called ${slug}.` });
      return room;
    }
    const held = list.filter(
      (room) => room.archivedAt === null && room.threadIds.includes(threadId),
    );
    if (held.length === 1) return held[0]!;
    return yield* new RoomsError({
      message:
        held.length === 0
          ? "This thread is not in a room. Pass room; room_context lists them."
          : `This thread is in several rooms (${held.map((room) => room.slug).join(", ")}). Pass room.`,
    });
  });

  const contextOf = Effect.fn("RoomsToolkit.contextOf")(function* (room: Room, you: ThreadId) {
    const shells = yield* Effect.forEach(room.threadIds, threadShell, { concurrency: 8 });
    const shelf = yield* rooms.shelf(room.slug);
    return {
      slug: room.slug,
      title: room.title,
      outcome: room.outcome,
      archived: room.archivedAt !== null,
      note: room.note,
      threads: shells.flatMap((thread) =>
        thread && thread.archivedAt === null
          ? [
              {
                threadId: thread.id,
                title: thread.title,
                you: thread.id === you,
                status: thread.session?.status ?? "idle",
                settled: thread.settledOverride === "settled",
                lastActivityAt:
                  thread.latestTurn?.completedAt ??
                  thread.latestTurn?.requestedAt ??
                  thread.updatedAt,
              },
            ]
          : [],
      ),
      shelf: { total: shelf.length, recent: shelf.slice(0, RECENT_SHELF) },
    };
  });

  return RoomsToolkit.of({
    room_context: ({ room: slug }) =>
      Effect.gen(function* () {
        const { threadId } = yield* caller;
        const list = yield* openRooms;
        const chosen =
          slug === undefined
            ? list.filter((room) => room.threadIds.includes(threadId))
            : [yield* resolveRoom(slug, threadId)];
        const chosenSlugs = new Set(chosen.map((room) => room.slug));
        return {
          rooms: yield* Effect.forEach(chosen, (room) => contextOf(room, threadId)),
          otherRooms: list
            .filter((room) => !chosenSlugs.has(room.slug))
            .map((room) => ({ slug: room.slug, title: room.title })),
        } satisfies RoomContextResult;
      }),

    send_to_thread: ({ threadId: targetId, message }) =>
      Effect.gen(function* () {
        const { threadId } = yield* caller;
        if (targetId === threadId) {
          return yield* new RoomsError({ message: "That is this thread." });
        }
        const sender = yield* threadShell(threadId);
        const target = yield* threadShell(ThreadId.make(targetId));
        if (!sender || !target) {
          return yield* new RoomsError({ message: `There is no thread ${targetId}.` });
        }
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`server:mcp-send-to-thread:${target.id}:${uuid}`),
            threadId: target.id,
            message: {
              messageId: MessageId.make(uuid),
              role: "user",
              text: peerMessageText(sender, message),
              attachments: [],
            },
            // The target's own modes: a message must not change another agent's permissions.
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            createdAt,
          })
          .pipe(Effect.mapError(failWith(`Could not message ${target.title}.`)));
        return { threadId: target.id, title: target.title };
      }),

    shelf_add: ({ ref, title, room: slug }) =>
      Effect.gen(function* () {
        const { threadId } = yield* caller;
        const room = yield* resolveRoom(slug, threadId);
        let resolved = ref;
        if (!/^https?:\/\//i.test(ref)) {
          const thread = yield* threadShell(threadId);
          const project = thread
            ? yield* snapshots.getProjectShellById(thread.projectId).pipe(
                Effect.map(Option.getOrNull),
                Effect.orElseSucceed(() => null),
              )
            : null;
          const root = thread?.worktreePath ?? project?.workspaceRoot;
          if (!path.isAbsolute(ref) && !root) {
            return yield* new RoomsError({
              message: "This thread has no worktree to resolve against. Pass an absolute path.",
            });
          }
          resolved = path.isAbsolute(ref) ? path.normalize(ref) : path.resolve(root!, ref);
          if (!(yield* fs.exists(resolved).pipe(Effect.orElseSucceed(() => false)))) {
            return yield* new RoomsError({ message: `There is no file at ${resolved}.` });
          }
        }
        const added = yield* rooms.addDocument({ slug: room.slug, ref: resolved, title, threadId });
        return { room: room.slug, ...added };
      }),

    room_note: ({ note, basedOn, room: slug }) =>
      Effect.gen(function* () {
        const { threadId } = yield* caller;
        const room = yield* resolveRoom(slug, threadId);
        const updated = yield* rooms.setNote({ slug: room.slug, body: note, threadId, basedOn });
        return {
          room: updated.slug,
          length: updated.note?.body.length ?? 0,
          revision: updated.note?.revision ?? 0,
        };
      }),

    start_thread: ({
      prompt,
      title,
      worktree,
      baseBranch,
      branch,
      room,
      project,
      provider,
      model,
    }) =>
      Effect.gen(function* () {
        const { threadId } = yield* caller;
        const sender = yield* threadShell(threadId);
        if (!sender) return yield* new RoomsError({ message: "This thread is not known to T3." });
        return yield* launcher.start({
          from: sender.id,
          text: startedByText(sender, prompt),
          title,
          worktree: worktree ?? "same",
          baseBranch,
          branch,
          room,
          project,
          provider,
          model,
        });
      }),

    room_move: ({ room, threadId: target }) =>
      Effect.gen(function* () {
        const threadId = target ?? (yield* caller).threadId;
        if (!(yield* threadShell(ThreadId.make(threadId)))) {
          return yield* new RoomsError({ message: `There is no thread ${threadId}.` });
        }
        yield* rooms.moveThread({ threadId, slug: room });
        return { threadId, room };
      }),
  });
});

export const RoomsToolkitHandlersLive = RoomsToolkit.toLayer(make);
