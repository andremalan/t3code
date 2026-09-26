// HQ Rooms: full main-panel room overview. Picking a room sets the sidebar
// filter and opens that room's most recently active thread. Rooms drag to reorder, to
// another section or to Archived; threads outside any room drag onto a room. All write to HQ.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ArchiveIcon, CheckIcon } from "lucide-react";
import { type DragEvent, useEffect, useMemo, useState } from "react";

import { resolveThreadStatusPill } from "../components/Sidebar.logic";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useThreadActions } from "../hooks/useThreadActions";
import {
  archiveHqRoom,
  HQ_ATTENTION_LABELS,
  type HqRoom,
  hqRoomThreads,
  hqUnroomedThreads,
  HqThreadActions,
  moveHqRoom,
  setHqThreadRoom,
  threadActivityMs,
  unarchiveHqRoom,
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
  ["permanent", "Permanent"],
  ["backlog", "Backlog"],
] as const;
const ROOM_DRAG = "application/x-hq-room";
const THREAD_DRAG = "application/x-hq-thread";
type DragKind = typeof ROOM_DRAG | typeof THREAD_DRAG;

function RoomsRouteView() {
  const openRoom = useOpenHqRoom();
  const navigate = useNavigate();
  const { rooms, archivedRooms, selectedSlug } = useHqRooms();
  const threads = useThreadShells();
  const [status, setStatus] = useState("");
  const [over, setOver] = useState<{ name: string; kind: DragKind } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const { settleThread } = useThreadActions();

  const act = (work: Promise<string | void>) => {
    setStatus("");
    work.then(
      (said) => setStatus(said || ""),
      (error: unknown) => setStatus(error instanceof Error ? error.message : String(error)),
    );
  };
  // A card sits inside its section, so a target that takes the drag stops it there.
  const dropTarget = (
    name: string,
    handlers: Partial<Record<DragKind, (value: string) => void>>,
  ) => {
    const kindOf = (event: DragEvent) =>
      (Object.keys(handlers) as DragKind[]).find((kind) => event.dataTransfer.types.includes(kind));
    return {
      onDragOver: (event: DragEvent) => {
        const kind = kindOf(event);
        if (!kind) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        if (over?.name !== name || over.kind !== kind) setOver({ name, kind });
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
      },
      onDrop: (event: DragEvent) => {
        const kind = kindOf(event);
        if (!kind) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(null);
        const value = event.dataTransfer.getData(kind);
        if (value) handlers[kind]?.(value);
      },
    };
  };
  const isOver = (name: string, kind: DragKind) => over?.name === name && over.kind === kind;

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
    // HQ's room order, which dragging sets.
    return ZONES.map(([zone, title]) => ({
      zone,
      title,
      cards: [
        ...(zone === "today" ? [all] : []),
        ...roomCards.filter((card) => card.zone === zone),
      ],
    }));
  }, [rooms, threads]);
  const unroomed = useMemo(() => hqUnroomedThreads(rooms, threads), [rooms, threads]);

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
            Open a room for its threads and shelf; it also filters the sidebar. Drag rooms to
            reorder them, and drag a thread onto a room to add it. Hover a room&apos;s thread to
            replace or remove it. Esc to go back.
          </span>
          {status ? (
            <span role="status" className="ml-auto text-xs text-muted-foreground">
              {status}
            </span>
          ) : null}
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {cards.map((section) => (
              <div
                key={section.zone}
                className={cn(
                  "-m-2 mb-4 rounded-xl p-2",
                  isOver(section.zone, ROOM_DRAG) && "bg-accent/50 ring-1 ring-primary/40",
                )}
                data-testid={`hq-rooms-section-${section.zone}`}
                {...dropTarget(section.zone, {
                  [ROOM_DRAG]: (slug) => act(moveHqRoom(slug, section.zone)),
                })}
              >
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
                        "group relative flex flex-col rounded-xl border bg-card/40 text-sm transition-colors hover:border-foreground/30",
                        card.slug === selectedSlug ? "border-primary/60" : "border-border",
                        // A room lands before the card it is dropped on.
                        isOver(`card:${card.slug}`, ROOM_DRAG) &&
                          "shadow-[inset_4px_0_0] shadow-primary",
                        isOver(`card:${card.slug}`, THREAD_DRAG) &&
                          "bg-accent/50 ring-2 ring-primary/50",
                      )}
                      data-testid="hq-room-card"
                      {...(card.slug
                        ? dropTarget(`card:${card.slug}`, {
                            [ROOM_DRAG]: (slug) => act(moveHqRoom(slug, section.zone, card.slug)),
                            [THREAD_DRAG]: (threadId) =>
                              act(setHqThreadRoom(card.slug!, threadId, true)),
                          })
                        : {})}
                      draggable={card.slug !== null}
                      onDragStart={(event) => {
                        if (!card.slug) return;
                        event.dataTransfer.setData(ROOM_DRAG, card.slug);
                        event.dataTransfer.effectAllowed = "move";
                      }}
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
                      {card.slug ? (
                        <button
                          type="button"
                          aria-label={`Archive ${card.label}`}
                          title="Archive room"
                          className="absolute top-2 right-2 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
                          onClick={() => act(archiveHqRoom(card.slug!))}
                        >
                          <ArchiveIcon className="size-3.5" />
                        </button>
                      ) : null}
                      <ul className="flex flex-col border-t border-border/60 py-1">
                        {card.threads.slice(0, PREVIEW_THREADS).map((thread) => {
                          const status = resolveThreadStatusPill({ thread });
                          return (
                            <li
                              key={`${thread.environmentId}:${thread.id}`}
                              className="group/row relative"
                            >
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs group-hover/row:bg-accent"
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
                                <span
                                  className={cn(
                                    "shrink-0 text-muted-foreground",
                                    card.slug && "group-hover/row:invisible",
                                  )}
                                >
                                  {formatRelativeTimeLabel(
                                    new Date(threadActivityMs(thread)).toISOString(),
                                  )}
                                </span>
                              </button>
                              {card.slug ? (
                                <HqThreadActions
                                  slug={card.slug}
                                  thread={thread}
                                  onStatus={setStatus}
                                />
                              ) : null}
                            </li>
                          );
                        })}
                        {card.threads.length === 0 ? (
                          <li className="px-3 py-1 text-xs text-muted-foreground">
                            No threads yet
                          </li>
                        ) : null}
                      </ul>
                    </section>
                  ))}
                  {section.cards.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
                      Drag rooms here
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
            <div
              className={cn(
                "-m-2 mb-4 rounded-xl p-2",
                isOver("archive", ROOM_DRAG) && "bg-accent/50 ring-1 ring-primary/40",
              )}
              data-testid="hq-rooms-archived"
              {...dropTarget("archive", { [ROOM_DRAG]: (slug) => act(archiveHqRoom(slug)) })}
            >
              <button
                type="button"
                className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((shown) => !shown)}
              >
                <ArchiveIcon className="size-3" />
                Archived {archivedRooms.length}
                <span className="font-normal tracking-normal normal-case">
                  {showArchived ? "· hide" : "· show · drop a room here to archive it"}
                </span>
              </button>
              {showArchived ? (
                <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border text-sm">
                  {archivedRooms.map((room) => (
                    <li key={room.slug} className="flex items-center gap-2 px-3 py-1.5">
                      <span className="min-w-0 flex-1 truncate">{room.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatRelativeTimeLabel(room.archivedAt)}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-xs hover:bg-accent"
                        onClick={() => act(unarchiveHqRoom(room.slug))}
                      >
                        Unarchive
                      </button>
                    </li>
                  ))}
                  {archivedRooms.length === 0 ? (
                    <li className="px-3 py-1.5 text-xs text-muted-foreground">No archived rooms</li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          </div>
          <aside
            className="hidden w-72 shrink-0 flex-col border-l border-border md:flex"
            data-testid="hq-rooms-unroomed"
          >
            <h2 className="px-3 pt-4 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase sm:pt-6">
              Not in a room {unroomed.length}
            </h2>
            <p className="px-3 pb-2 text-xs text-muted-foreground">
              Unsettled threads. Drag one onto a room to add it, or settle it.
            </p>
            <ul className="min-h-0 flex-1 overflow-y-auto pb-4">
              {unroomed.map((thread) => {
                const status = resolveThreadStatusPill({ thread });
                return (
                  <li
                    key={`${thread.environmentId}:${thread.id}`}
                    className="group/row relative"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(THREAD_DRAG, thread.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                  >
                    <button
                      type="button"
                      className="flex w-full cursor-grab items-center gap-2 px-3 py-1 text-left text-xs group-hover/row:bg-accent"
                      onClick={() => open(null, thread)}
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
                      <span className="shrink-0 text-muted-foreground group-hover/row:invisible">
                        {formatRelativeTimeLabel(new Date(threadActivityMs(thread)).toISOString())}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label="Settle thread"
                      title="Settle thread"
                      className="pointer-events-none absolute inset-y-0 right-1 my-auto flex h-6 items-center rounded bg-accent px-1.5 text-muted-foreground opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100"
                      onClick={() =>
                        void settleThread(scopeThreadRef(thread.environmentId, thread.id)).then(
                          (result) =>
                            result._tag === "Success" || setStatus("Could not settle that thread."),
                        )
                      }
                    >
                      <CheckIcon className="size-3" />
                    </button>
                  </li>
                );
              })}
              {unroomed.length === 0 ? (
                <li className="px-3 py-1 text-xs text-muted-foreground">
                  Every thread is in a room
                </li>
              ) : null}
            </ul>
          </aside>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/rooms")({
  component: RoomsRouteView,
});
