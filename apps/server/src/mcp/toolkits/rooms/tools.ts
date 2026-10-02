import {
  ROOM_NOTE_MAX_LENGTH,
  RoomNote,
  RoomsError,
  RoomShelfDoc,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as Rooms from "../../../rooms/Rooms.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  Rooms.Rooms,
];

const RoomInput = TrimmedNonEmptyString.annotate({
  description:
    "Room slug. Defaults to the room this thread belongs to; required when it belongs to none or several.",
});

export const RoomThreadEntry = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  you: Schema.Boolean.annotate({ description: "True for the thread calling this tool." }),
  status: Schema.String.annotate({ description: "Provider session status; idle when none." }),
  settled: Schema.Boolean,
  lastActivityAt: Schema.String,
});

export const RoomContextEntry = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  outcome: Schema.String,
  archived: Schema.Boolean,
  note: Schema.NullOr(RoomNote).annotate({
    description:
      "The room's shared board: where things stand and what is next. Null until written.",
  }),
  threads: Schema.Array(RoomThreadEntry),
  shelf: Schema.Struct({
    total: Schema.Int,
    recent: Schema.Array(RoomShelfDoc).annotate({ description: "Newest first, at most 25." }),
  }),
});

export const RoomContextResult = Schema.Struct({
  rooms: Schema.Array(RoomContextEntry),
  otherRooms: Schema.Array(Schema.Struct({ slug: Schema.String, title: Schema.String })).annotate({
    description: "Every other open room, for passing as room.",
  }),
});
export type RoomContextResult = typeof RoomContextResult.Type;

const RoomContextTool = Tool.make("room_context", {
  description:
    "Read this thread's room: its outcome, its note (the shared board of where things stand), the threads in it with their status, and the newest shelf documents (PRs, files under cc/<room>/ in member worktrees, recorded links). Read it when you start, after compaction, and at natural work boundaries.",
  parameters: Schema.Struct({ room: Schema.optional(RoomInput) }),
  success: RoomContextResult,
  failure: RoomsError,
  dependencies,
})
  .annotate(Tool.Title, "Read room context")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SendToThreadTool = Tool.make("send_to_thread", {
  description:
    "Send a message to another T3 thread. It arrives as a new turn in that thread, marked as coming from this thread, and starts its agent. Use it for new work or a correction that needs action, not routine status. Find thread ids with room_context.",
  parameters: Schema.Struct({
    threadId: TrimmedNonEmptyString.annotate({ description: "The thread to message." }),
    message: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({ threadId: Schema.String, title: Schema.String }),
  failure: RoomsError,
  dependencies,
})
  .annotate(Tool.Title, "Send to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ShelfAddTool = Tool.make("shelf_add", {
  description:
    "Put a deliverable on the room's shelf: a URL, or a file path (absolute, or relative to this thread's worktree). Files under cc/<room>/ in a member worktree are shelved automatically; use this for anything else. Pull requests are not shelved: link them with link_pull_request and the room shows them. Adding the same ref again updates its title.",
  parameters: Schema.Struct({
    ref: TrimmedNonEmptyString.annotate({ description: "URL or file path." }),
    title: Schema.optional(TrimmedNonEmptyString),
    room: Schema.optional(RoomInput),
  }),
  success: Schema.Struct({
    room: Schema.String,
    ref: Schema.String,
    title: Schema.String,
    kind: Schema.String,
  }),
  failure: RoomsError,
  dependencies,
})
  .annotate(Tool.Title, "Add to room shelf")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RoomNoteTool = Tool.make("room_note", {
  description: `Replace the room's note: the shared board every thread in the room reads through room_context. Write the whole note, not a diff: where things stand, open threads of work (who has them), decisions that hold, and next steps. Keep it under ${ROOM_NOTE_MAX_LENGTH} characters; history and detail go in cc/<room>/ documents. Update it at boundaries (a slice landed, a blocker, a decision, handing off), not every turn. Read room_context first so you keep what other threads wrote. An empty note clears it.`,
  parameters: Schema.Struct({
    note: Schema.String,
    room: Schema.optional(RoomInput),
  }),
  success: Schema.Struct({ room: Schema.String, length: Schema.Int }),
  failure: RoomsError,
  dependencies,
})
  .annotate(Tool.Title, "Update room note")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RoomMoveTool = Tool.make("room_move", {
  description:
    "Move a thread into a room, taking it out of any other open room; pass room null to take it out of every room. Defaults to this thread. Use it when work belongs to a different room, or to seat a thread you started. room_context lists rooms.",
  parameters: Schema.Struct({
    room: Schema.NullOr(TrimmedNonEmptyString).annotate({ description: "Room slug, or null." }),
    threadId: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "Thread to move. Defaults to this thread." }),
    ),
  }),
  success: Schema.Struct({ threadId: Schema.String, room: Schema.NullOr(Schema.String) }),
  failure: RoomsError,
  dependencies,
})
  .annotate(Tool.Title, "Move thread to room")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/** HQ fork: rooms for agents. Every thread gets it; the tools say so when a thread has no room. */
export const RoomsToolkit = Toolkit.make(
  RoomContextTool,
  SendToThreadTool,
  ShelfAddTool,
  RoomNoteTool,
  RoomMoveTool,
);
