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
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Rooms from "../../../rooms/Rooms.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
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
  shelfDir: Schema.String.annotate({
    description: "The folder holding the room's shelved files; anything written here is shelved.",
  }),
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
    "Read this thread's room: its outcome, its note (the shared board of where things stand), the threads in it with their status, and the newest shelf documents (PRs, shelved files, recorded links). Read it when you start, after compaction, and at natural work boundaries.",
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

const ShelfAddTool = Tool.make("shelf_add", {
  description:
    "Put a deliverable on the room's shelf: a URL, or a file path (absolute, or relative to this thread's worktree). A file is copied into the room's shelf folder, which outlives worktrees; link to the returned ref when you mention it. Shelving under the same name again replaces the copy, so shelve again after changing a deliverable. Pull requests are not shelved: link them with link_pull_request and the room shows them. Adding the same URL again updates its title.",
  parameters: Schema.Struct({
    ref: TrimmedNonEmptyString.annotate({ description: "URL or file path." }),
    title: Schema.optional(TrimmedNonEmptyString),
    name: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "Path for a file inside the shelf folder, like notes/plan.md. Defaults to the file's name.",
      }),
    ),
    room: Schema.optional(RoomInput),
  }),
  success: Schema.Struct({
    room: Schema.String,
    ref: Schema.String.annotate({ description: "The URL, or the shelved copy's path." }),
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
  description: `Replace the room's note: the shared board every thread in the room reads through room_context. Write the whole note, not a diff: where things stand, open threads of work (who has them), decisions that hold, and next steps. Keep it under ${ROOM_NOTE_MAX_LENGTH} characters; history and detail go in shelf documents. Update it at boundaries (a slice landed, a blocker, a decision, handing off), not every turn. Read room_context first and pass the note's revision as basedOn (null when the room has no note): if another thread wrote in between, the update is refused so you can reread and merge. An empty note clears it.`,
  parameters: Schema.Struct({
    note: Schema.String,
    basedOn: Schema.NullOr(Schema.Int).annotate({
      description: "The note's revision from room_context, or null when it had no note.",
    }),
    room: Schema.optional(RoomInput),
  }),
  success: Schema.Struct({
    room: Schema.String,
    length: Schema.Int,
    revision: Schema.Int.annotate({ description: "Pass as basedOn on your next update." }),
  }),
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
export const RoomsToolkit = Toolkit.make(RoomContextTool, ShelfAddTool, RoomNoteTool, RoomMoveTool);
