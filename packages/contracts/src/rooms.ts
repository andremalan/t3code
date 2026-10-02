import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** HQ fork: rooms group threads. A room's slug is its stable id; renaming changes the title only. */
export const RoomSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).check(
  Schema.isMaxLength(64),
);
export type RoomSlug = typeof RoomSlug.Type;

export const ROOM_SECTIONS = ["today", "permanent", "backlog"] as const;
export const RoomSection = Schema.Literals(ROOM_SECTIONS);
export type RoomSection = typeof RoomSection.Type;

/** Longest room note, in characters: a board of where things stand, not a log. */
export const ROOM_NOTE_MAX_LENGTH = 2000;

/** A room's shared board: where the work stands, open threads of work, next steps. Replaced whole. */
export const RoomNote = Schema.Struct({
  body: Schema.String,
  /** The thread that last wrote it; null when written from a client. */
  threadId: Schema.NullOr(ThreadId),
  updatedAt: IsoDateTime,
});
export type RoomNote = typeof RoomNote.Type;

export const Room = Schema.Struct({
  slug: RoomSlug,
  title: TrimmedNonEmptyString,
  outcome: Schema.String,
  section: RoomSection,
  archivedAt: Schema.NullOr(IsoDateTime),
  threadIds: Schema.Array(ThreadId),
  note: Schema.NullOr(RoomNote),
});
export type Room = typeof Room.Type;

/** Every room, archived ones included, in section order and then position within the section. */
export const RoomList = Schema.Array(Room);
export type RoomList = typeof RoomList.Type;

export const RoomCreateInput = Schema.Struct({
  slug: RoomSlug,
  title: TrimmedNonEmptyString,
  outcome: Schema.String,
  section: RoomSection,
});
export type RoomCreateInput = typeof RoomCreateInput.Type;

export const RoomUpdateInput = Schema.Struct({
  slug: RoomSlug,
  title: Schema.optional(TrimmedNonEmptyString),
  outcome: Schema.optional(Schema.String),
  archived: Schema.optional(Schema.Boolean),
  /** Replaces the room note; an empty string clears it. */
  note: Schema.optional(Schema.String),
});
export type RoomUpdateInput = typeof RoomUpdateInput.Type;

/** The full order of each section. Rooms left out keep their section and position. */
export const RoomReorderInput = Schema.Struct({
  today: Schema.Array(RoomSlug),
  permanent: Schema.Array(RoomSlug),
  backlog: Schema.Array(RoomSlug),
});
export type RoomReorderInput = typeof RoomReorderInput.Type;

export const RoomSetThreadInput = Schema.Struct({
  slug: RoomSlug,
  threadId: ThreadId,
  member: Schema.Boolean,
});
export type RoomSetThreadInput = typeof RoomSetThreadInput.Type;

export class RoomsError extends Schema.TaggedError<RoomsError>()("RoomsError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const RoomShelfInput = Schema.Struct({ slug: RoomSlug });
export type RoomShelfInput = typeof RoomShelfInput.Type;

/**
 * A document on a room's shelf: a file on the environment host (an absolute path) or a URL.
 * `threadId` is the member thread that added or owns it; a file opens in that thread's preview.
 */
export const RoomShelfDoc = Schema.Struct({
  ref: Schema.String,
  title: Schema.String,
  /** "pr", a file extension, or the kind it was recorded with ("page", "md", "link"…). */
  kind: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  addedAt: Schema.String,
  prState: Schema.optionalKey(Schema.Literals(["draft", "open", "merged", "closed"])),
});
export type RoomShelfDoc = typeof RoomShelfDoc.Type;

/** Newest first. */
export const RoomShelf = Schema.Array(RoomShelfDoc);
export type RoomShelf = typeof RoomShelf.Type;
