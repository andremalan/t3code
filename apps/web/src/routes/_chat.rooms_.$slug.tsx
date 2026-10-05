// HQ Rooms: one room's page. Visiting it filters the sidebar to the room, which lists its
// threads (settled ones under Settled); the page holds the shelf. Shelf files open in a room
// thread's file preview, or the newest thread's when the room has none.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { RoomNote } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { Button } from "../components/ui/button";
import {
  hqRoomThreads,
  selectHqRoom,
  setHqRoomNote,
  updateHqRoom,
  useHqRooms,
  usePrimaryThreadShells,
} from "../hqRooms";
import { HqShelfList } from "../hqShelf";
import { formatRelativeTimeLabel } from "../timestampFormat";

const NOTE_MAX = 2000;

/** The room's outcome, and the way to rename the room or change its outcome. */
function RoomDetails(props: { slug: string; title: string; outcome: string }) {
  const [draft, setDraft] = useState<{ title: string; outcome: string } | null>(null);
  // What the form opened with: a field counts as changed only against this, so an update from
  // another client while the form is open is not overwritten by a field left alone.
  const [opened, setOpened] = useState({ title: "", outcome: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (draft === null) {
    return (
      <div className="mb-6 flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm">
          {props.outcome || <span className="text-muted-foreground">No outcome yet.</span>}
        </p>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setError("");
            setOpened({ title: props.title, outcome: props.outcome });
            setDraft({ title: props.title, outcome: props.outcome });
          }}
        >
          Edit room
        </Button>
      </div>
    );
  }
  return (
    <form
      className="mb-6 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        const changed = {
          ...(draft.title.trim() !== opened.title ? { title: draft.title } : {}),
          ...(draft.outcome.trim() !== opened.outcome ? { outcome: draft.outcome } : {}),
        };
        if (Object.keys(changed).length === 0) return setDraft(null);
        setBusy(true);
        updateHqRoom(props.slug, changed).then(
          () => {
            setBusy(false);
            setDraft(null);
          },
          (failure: unknown) => {
            setBusy(false);
            setError(failure instanceof Error ? failure.message : String(failure));
          },
        );
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Name</span>
        <input
          value={draft.title}
          required
          maxLength={120}
          autoFocus
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Outcome</span>
        <textarea
          value={draft.outcome}
          maxLength={500}
          rows={3}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, outcome: event.target.value })}
          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
        />
      </label>
      <div className="flex items-center gap-2">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="ml-auto"
          disabled={busy}
          onClick={() => setDraft(null)}
        >
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

/** The room's shared board, written by its threads through room_note; editable here too. */
function RoomNoteView(props: { slug: string; note: RoomNote | null; writer: string | null }) {
  const [draft, setDraft] = useState<string | null>(null);
  // The revision the draft started from, so a thread's update meanwhile is not overwritten.
  const [basedOn, setBasedOn] = useState<number | null>(null);
  const [error, setError] = useState("");
  const edit = () => {
    setError("");
    setBasedOn(props.note?.revision ?? null);
    setDraft(props.note?.body ?? "");
  };
  const save = () => {
    if (draft === null) return;
    setError("");
    setHqRoomNote(props.slug, draft, basedOn).then(
      () => setDraft(null),
      (failure: unknown) => {
        const message = failure instanceof Error ? failure.message : String(failure);
        setError(
          message.includes("changed since you read it") || message.includes("cleared since")
            ? "A thread updated this note while you were editing. Copy your draft, cancel to see the new note, then edit again."
            : message,
        );
      },
    );
  };
  return (
    <section className="mb-6" data-testid="hq-room-note">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Note</h2>
        {props.note?.body && draft === null ? (
          <span className="text-xs text-muted-foreground">
            {formatRelativeTimeLabel(props.note.updatedAt)}
            {props.writer ? ` · ${props.writer}` : ""}
          </span>
        ) : null}
        {draft === null ? (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={edit}>
            Edit
          </Button>
        ) : null}
      </div>
      {draft === null ? (
        props.note?.body ? (
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
  const threads = usePrimaryThreadShells();
  const room = rooms.find((candidate) => candidate.slug === slug) ?? null;
  const threadRefs = useMemo(() => {
    const members = room ? hqRoomThreads(room, threads, { includeSettled: true }) : [];
    // A room without threads (one carried over from another machine, say) still opens its files.
    return (members.length > 0 ? members : hqRoomThreads(null, threads).slice(0, 1)).map(
      (thread) => ({ environmentId: thread.environmentId, threadId: thread.id }),
    );
  }, [room, threads]);

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
                {rooms.length === 0 ? "Loading rooms…" : "There is no room with this name."}
              </p>
            ) : (
              <>
                <RoomDetails key={slug} slug={slug} title={room.label} outcome={room.outcome} />
                <RoomNoteView
                  key={slug}
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
