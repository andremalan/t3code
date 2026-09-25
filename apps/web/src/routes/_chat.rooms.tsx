// HQ Rooms spike: full main-panel room overview. Picking a room sets the sidebar
// filter and opens that room's most recently active thread.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { resolveThreadStatusPill } from "../components/Sidebar.logic";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import {
  HQ_ATTENTION_LABELS,
  type HqRoom,
  hqRoomThreads,
  threadActivityMs,
  useHqRooms,
  useOpenHqRoom,
} from "../hqRooms";
import { cn } from "../lib/utils";
import { useThreadShells } from "../state/entities";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";

const PREVIEW_THREADS = 4;

type RoomCard = {
  slug: string | null;
  label: string;
  attention: readonly string[];
  zone: HqRoom["zone"];
  agents: number;
  shelf: number;
  threads: SidebarThreadSummary[];
  latestMs: number;
};
const ZONES = [
  ["today", "Today"],
  ["backlog", "Backlog"],
  ["permanent", "Permanent"],
] as const;

function RoomsRouteView() {
  const openRoom = useOpenHqRoom();
  const navigate = useNavigate();
  const { rooms, selectedSlug } = useHqRooms();
  const threads = useThreadShells();

  const cards = useMemo(() => {
    const roomCards = rooms.map((room): RoomCard => {
      const roomThreads = hqRoomThreads(room, threads);
      return {
        slug: room.slug as string | null,
        label: room.label,
        attention: room.attention,
        zone: room.zone,
        agents: room.agents,
        shelf: room.shelf.length,
        threads: roomThreads,
        latestMs: roomThreads[0] ? threadActivityMs(roomThreads[0]) : 0,
      };
    });
    const allThreads = hqRoomThreads(null, threads);
    const all: RoomCard = {
      slug: null,
      label: "All threads",
      attention: [],
      zone: "today",
      agents: 0,
      shelf: 0,
      threads: allThreads,
      latestMs: allThreads[0] ? threadActivityMs(allThreads[0]) : 0,
    };
    const shown = roomCards
      .filter((card) => card.threads.length > 0 || card.agents > 0)
      .toSorted(
        (a, b) =>
          Number(b.attention.length > 0) - Number(a.attention.length > 0) ||
          b.latestMs - a.latestMs,
      );
    return ZONES.map(([zone, title]) => ({
      zone,
      title,
      cards: [...(zone === "today" ? [all] : []), ...shown.filter((card) => card.zone === zone)],
    })).filter((section) => section.cards.length > 0);
  }, [rooms, threads]);

  const open = (slug: string | null, thread: SidebarThreadSummary | undefined) => {
    if (!openRoom(slug, thread)) window.history.back();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) window.history.back();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-sm font-medium">Rooms</span>
          <span className="text-xs text-muted-foreground">
            Open a room for its threads and shelf; it also filters the sidebar. Esc to go back.
          </span>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {cards.map((section) => (
            <div key={section.zone} className="mb-6">
              <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {section.title}
              </h2>
              <div
                className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(18rem,1fr))]"
                data-testid="hq-rooms-grid"
              >
                {section.cards.map((card) => (
                  <section
                    key={card.slug ?? "all"}
                    className={cn(
                      "flex flex-col rounded-xl border bg-card/40 text-sm transition-colors hover:border-foreground/30",
                      card.slug === selectedSlug ? "border-primary/60" : "border-border",
                    )}
                    data-testid="hq-room-card"
                  >
                    <button
                      type="button"
                      className="flex flex-col gap-1 px-3 pt-3 pb-2 text-left"
                      onClick={() =>
                        card.slug
                          ? void navigate({ to: "/rooms/$slug", params: { slug: card.slug } })
                          : open(null, card.threads[0])
                      }
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{card.label}</span>
                        {card.attention.map((flag) => (
                          <span
                            key={flag}
                            className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300"
                          >
                            {HQ_ATTENTION_LABELS[flag] ?? flag}
                          </span>
                        ))}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {card.threads.length} threads
                        {card.agents > 0 ? ` · ${card.agents} seated` : ""}
                        {card.shelf > 0 ? ` · ${card.shelf} on shelf` : ""}
                        {card.latestMs > 0
                          ? ` · ${formatRelativeTimeLabel(new Date(card.latestMs).toISOString())}`
                          : ""}
                      </span>
                    </button>
                    <ul className="flex flex-col border-t border-border/60 py-1">
                      {card.threads.slice(0, PREVIEW_THREADS).map((thread) => {
                        const status = resolveThreadStatusPill({ thread });
                        return (
                          <li key={`${thread.environmentId}:${thread.id}`}>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent"
                              onClick={() => open(card.slug, thread)}
                              title={status?.label}
                            >
                              <span
                                className={cn(
                                  "size-1.5 shrink-0 rounded-full",
                                  status ? status.dotClass : "bg-transparent",
                                  status?.pulse && "animate-pulse",
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                              <span className="shrink-0 text-muted-foreground">
                                {formatRelativeTimeLabel(
                                  new Date(threadActivityMs(thread)).toISOString(),
                                )}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                      {card.threads.length === 0 ? (
                        <li className="px-3 py-1 text-xs text-muted-foreground">No threads yet</li>
                      ) : null}
                    </ul>
                  </section>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/rooms")({
  component: RoomsRouteView,
});
