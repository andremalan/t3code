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

export const Room = Schema.Struct({
  slug: RoomSlug,
  title: TrimmedNonEmptyString,
  outcome: Schema.String,
  section: RoomSection,
  archivedAt: Schema.NullOr(IsoDateTime),
  threadIds: Schema.Array(ThreadId),
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
