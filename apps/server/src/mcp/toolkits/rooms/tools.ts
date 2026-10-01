import { RoomsError, RoomShelfDoc, TrimmedNonEmptyString } from "@t3tools/contracts";
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
    "Read this thread's room: its outcome, the threads in it with their status, and the newest shelf documents (PRs, files under cc/<room>/ in member worktrees, recorded links). Read it at natural work boundaries.",
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

/** HQ fork: rooms for agents. Every thread gets it; the tools say so when a thread has no room. */
export const RoomsToolkit = Toolkit.make(RoomContextTool, SendToThreadTool, ShelfAddTool);
