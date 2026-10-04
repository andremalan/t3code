import { type Room, RoomsError, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Rooms from "../../../rooms/Rooms.ts";
import { readCaller, readMutationCaller } from "../../threadAccess.ts";
import { type RoomContextResult, RoomsToolkit } from "./tools.ts";

const RECENT_SHELF = 25;

const failWith = (message: string) => (cause: unknown) => new RoomsError({ message, cause });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const rooms = yield* Rooms.Rooms;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Upstream's caller checks: reads need the orchestration capability, writes an active run that
  // this provider owns. A room_move target may be in another project: rooms span projects.
  const asRoomsError = (failure: { readonly message: string }) =>
    new RoomsError({ message: failure.message });
  const reader = readCaller().pipe(
    Effect.map(({ caller }) => ({ threadId: caller.id })),
    Effect.mapError(asRoomsError),
  );
  const writer = readMutationCaller().pipe(
    Effect.map(({ caller }) => ({ threadId: caller.id })),
    Effect.mapError(asRoomsError),
  );

  const threadShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(Effect.mapError(failWith("Could not read threads.")));

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
    const shells = yield* Effect.forEach(
      room.threadIds,
      (threadId) => threadShell(ThreadId.make(threadId)),
      { concurrency: 8 },
    );
    const shelf = yield* rooms.shelf(room.slug);
    return {
      slug: room.slug,
      title: room.title,
      outcome: room.outcome,
      archived: room.archivedAt !== null,
      note: room.note,
      threads: shells.flatMap((thread) =>
        thread && thread.archivedAt === null && thread.deletedAt === null
          ? [
              {
                threadId: thread.id,
                title: thread.title,
                you: thread.id === you,
                status: thread.status,
                settled: thread.settledOverride === "settled",
                lastActivityAt: DateTime.formatIso(
                  thread.latestRunCompletedAt ?? thread.latestRunRequestedAt ?? thread.updatedAt,
                ),
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
        const { threadId } = yield* reader;
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

    shelf_add: ({ ref, title, room: slug }) =>
      Effect.gen(function* () {
        const { threadId } = yield* writer;
        const room = yield* resolveRoom(slug, threadId);
        let resolved = ref;
        if (!/^https?:\/\//i.test(ref)) {
          const thread = yield* threadShell(threadId);
          const project = thread
            ? yield* projects.getShell(thread.projectId).pipe(
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
        const { threadId } = yield* writer;
        const room = yield* resolveRoom(slug, threadId);
        const updated = yield* rooms.setNote({ slug: room.slug, body: note, threadId, basedOn });
        return {
          room: updated.slug,
          length: updated.note?.body.length ?? 0,
          revision: updated.note?.revision ?? 0,
        };
      }),

    room_move: ({ room, threadId: target }) =>
      Effect.gen(function* () {
        const { threadId: callerId } = yield* writer;
        const threadId = target ?? callerId;
        if (!(yield* threadShell(ThreadId.make(threadId)))) {
          return yield* new RoomsError({ message: `There is no thread ${threadId}.` });
        }
        yield* rooms.moveThread({ threadId, slug: room });
        return { threadId, room };
      }),
  });
});

export const RoomsToolkitHandlersLive = RoomsToolkit.toLayer(make);
