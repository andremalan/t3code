// HQ Rooms: one room's page. Visiting it filters the sidebar to the room, which lists its
// threads (settled ones under Settled); the page holds the shelf. Shelf files open in a room
// thread's file preview.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { hqRoomThreads, selectHqRoom, useHqRooms } from "../hqRooms";
import { HqShelfList } from "../hqShelf";
import { useThreadShells } from "../state/entities";

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
