// HQ Rooms spike: one room's page. Visiting it filters the sidebar to the room;
// it lists the room's threads and shelf. Shelf files open in a room thread's file preview.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { resolveThreadStatusPill } from "../components/Sidebar.logic";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import {
  hqRoomThreads,
  HqThreadActions,
  selectHqRoom,
  threadActivityMs,
  useHqRooms,
  useOpenHqRoom,
} from "../hqRooms";
import { HqShelfList } from "../hqShelf";
import { cn } from "../lib/utils";
import { useThreadShells } from "../state/entities";
import { formatRelativeTimeLabel } from "../timestampFormat";

const relative = (ms: number) => formatRelativeTimeLabel(new Date(ms).toISOString());

function RoomRouteView() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const openRoom = useOpenHqRoom();
  const { rooms } = useHqRooms();
  const threads = useThreadShells();
  const room = rooms.find((candidate) => candidate.slug === slug) ?? null;
  const roomThreads = useMemo(() => (room ? hqRoomThreads(room, threads) : []), [room, threads]);
  const threadRefs = useMemo(
    () =>
      roomThreads.map((thread) => ({ environmentId: thread.environmentId, threadId: thread.id })),
    [roomThreads],
  );
  const [status, setStatus] = useState("");

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
          {status ? (
            <span role="status" className="ml-auto text-xs text-muted-foreground">
              {status}
            </span>
          ) : null}
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
            {room === null ? (
              <p className="text-sm text-muted-foreground">
                {rooms.length === 0 ? "Loading rooms…" : "HQ has no room with this name."}
              </p>
            ) : (
              <>
                <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Threads <span className="opacity-60">{roomThreads.length}</span>
                </h2>
                <ul className="mb-6 flex flex-col" data-testid="hq-room-threads">
                  {roomThreads.map((thread) => {
                    const status = resolveThreadStatusPill({ thread });
                    return (
                      <li
                        key={`${thread.environmentId}:${thread.id}`}
                        className="group/row relative"
                      >
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm group-hover/row:bg-accent"
                          onClick={() => openRoom(slug, thread)}
                        >
                          <span
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              status ? status.dotClass : "bg-transparent",
                              status?.pulse && "animate-pulse",
                            )}
                            title={status?.label}
                          />
                          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                          <span className="shrink-0 text-xs text-muted-foreground group-hover/row:invisible">
                            {relative(threadActivityMs(thread))}
                          </span>
                        </button>
                        <HqThreadActions slug={slug} thread={thread} onStatus={setStatus} />
                      </li>
                    );
                  })}
                </ul>
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
