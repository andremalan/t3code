// HQ Rooms: one room's page. Visiting it filters the sidebar to the room, which lists its
// threads (settled ones under Settled); the page holds the shelf. Shelf files open in a room
// thread's file preview.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { RoomNote } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { Button } from "../components/ui/button";
import { hqRoomThreads, selectHqRoom, setHqRoomNote, useHqRooms } from "../hqRooms";
import { HqShelfList } from "../hqShelf";
import { useThreadShells } from "../state/entities";
import { formatRelativeTimeLabel } from "../timestampFormat";

const NOTE_MAX = 2000;

/** The room's shared board, written by its threads through room_note; editable here too. */
function RoomNoteView(props: { slug: string; note: RoomNote | null; writer: string | null }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const save = () => {
    if (draft === null) return;
    setError("");
    setHqRoomNote(props.slug, draft).then(
      () => setDraft(null),
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    );
  };
  return (
    <section className="mb-6" data-testid="hq-room-note">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Note</h2>
        {props.note && draft === null ? (
          <span className="text-xs text-muted-foreground">
            {formatRelativeTimeLabel(props.note.updatedAt)}
            {props.writer ? ` · ${props.writer}` : ""}
          </span>
        ) : null}
        {draft === null ? (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => setDraft(props.note?.body ?? "")}
          >
            Edit
          </Button>
        ) : null}
      </div>
      {draft === null ? (
        props.note ? (
          <p className="text-sm whitespace-pre-wrap">{props.note.body}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            No note yet. Threads in this room write where things stand here.
          </p>
        )
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            maxLength={NOTE_MAX}
            rows={8}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
          <div className="flex items-center gap-2">
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <span className="ml-auto text-xs text-muted-foreground">
              {draft.length}/{NOTE_MAX}
            </span>
            <Button size="xs" variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="xs" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function RoomRouteView() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const { rooms } = useHqRooms();
  const threads = useThreadShells();
  const room = rooms.find((candidate) => candidate.slug === slug) ?? null;
  const threadRefs = useMemo(
    () =>
      (room ? hqRoomThreads(room, threads, { includeSettled: true }) : []).map((thread) => ({
        environmentId: thread.environmentId,
        threadId: thread.id,
      })),
    [room, threads],
  );

  useEffect(() => selectHqRoom(slug), [slug]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      void navigate({ to: "/rooms" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <Link to="/rooms" className="text-sm text-muted-foreground hover:text-foreground">
            Rooms
          </Link>
          <span className="text-sm text-muted-foreground">/</span>
          <span className="text-sm font-medium">{room?.label ?? slug}</span>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
            {room === null ? (
              <p className="text-sm text-muted-foreground">
                {rooms.length === 0 ? "Loading rooms…" : "HQ has no room with this name."}
              </p>
            ) : (
              <>
                {room.outcome ? <p className="mb-6 text-sm">{room.outcome}</p> : null}
                <RoomNoteView
                  slug={slug}
                  note={room.note}
                  writer={
                    room.note?.threadId
                      ? (threads.find((thread) => thread.id === room.note?.threadId)?.title ??
                        "a thread")
                      : room.note
                        ? "you"
                        : null
                  }
                />
                <HqShelfList slug={slug} threads={threadRefs} />
              </>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/rooms_/$slug")({
  component: RoomRouteView,
});
