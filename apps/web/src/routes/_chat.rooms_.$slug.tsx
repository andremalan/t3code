// HQ Rooms spike: one room's page. Visiting it filters the sidebar to the room;
// it lists the room's threads and shelf, and reads HQ documents in place.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { resolveThreadStatusPill } from "../components/Sidebar.logic";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import {
  HQ_ATTENTION_LABELS,
  hqRoomThreads,
  HqThreadActions,
  selectHqRoom,
  threadActivityMs,
  useHqRooms,
  useOpenHqRoom,
} from "../hqRooms";
import { HqDocReader, HqShelfList } from "../hqShelf";
import { cn } from "../lib/utils";
import { useThreadShells } from "../state/entities";
import { formatRelativeTimeLabel } from "../timestampFormat";

type RoomSearch = { doc?: string };

const relative = (ms: number) => formatRelativeTimeLabel(new Date(ms).toISOString());

function RoomRouteView() {
  const { slug } = Route.useParams();
  const { doc } = Route.useSearch();
  const navigate = useNavigate();
  const openRoom = useOpenHqRoom();
  const { rooms } = useHqRooms();
  const threads = useThreadShells();
  const room = rooms.find((candidate) => candidate.slug === slug) ?? null;
  const roomThreads = useMemo(() => (room ? hqRoomThreads(room, threads) : []), [room, threads]);
  const openDoc = room?.shelf.find((entry) => entry.target === doc) ?? null;
  const [status, setStatus] = useState("");

  useEffect(() => selectHqRoom(slug), [slug]);

  const setDoc = (target: string | undefined) =>
    void navigate({
      to: "/rooms/$slug",
      params: { slug },
      search: target ? { doc: target } : {},
      replace: true,
    });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (doc) setDoc(undefined);
      else void navigate({ to: "/rooms" });
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
          {room?.attention.map((flag) => (
            <span
              key={flag}
              className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300"
            >
              {HQ_ATTENTION_LABELS[flag] ?? flag}
            </span>
          ))}
          {status ? (
            <span role="status" className="ml-auto text-xs text-muted-foreground">
              {status}
            </span>
          ) : null}
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              "min-h-0 overflow-y-auto p-4 sm:p-6",
              // A phone has no room for both: the open document takes the page.
              openDoc
                ? "hidden md:block md:w-[26rem] md:shrink-0 md:border-r md:border-border"
                : "mx-auto w-full max-w-3xl",
            )}
          >
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
                <HqShelfList shelf={room.shelf} reading={doc} onRead={setDoc} />
              </>
            )}
          </div>
          {openDoc ? <HqDocReader doc={openDoc} onClose={() => setDoc(undefined)} /> : null}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/rooms_/$slug")({
  validateSearch: (raw: Record<string, unknown>): RoomSearch =>
    typeof raw.doc === "string" && raw.doc.startsWith("/hq/") ? { doc: raw.doc } : {},
  component: RoomRouteView,
});
