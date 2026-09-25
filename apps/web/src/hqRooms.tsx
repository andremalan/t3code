// HQ Rooms spike: rooms come from the local HQ app (proxied at /hq in dev) and
// filter the sidebar by thread id. Selection is a local preference; /rooms picks it.
import type { SidebarThreadSortOrder } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LayoutGridIcon, XIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";

export type HqRoom = {
  slug: string;
  label: string;
  /** HQ's own attention flags, e.g. "direct-done". */
  attention: readonly string[];
  zone: "today" | "backlog" | "permanent";
  /** Seated (non-lounge) agents. */
  agents: number;
  threadIds: ReadonlySet<string>;
};

type FloorRoom = {
  slug: string;
  label: string;
  attention?: string[];
  zone?: HqRoom["zone"];
  desks?: Array<{ threadUrl?: string }>;
  lounge?: Array<{ threadUrl?: string }>;
};

const SELECTED_KEY = "hq:selected-room";
// ponytail: polls HQ's full floor feed (~1.4 MB); a slim rooms→threads endpoint if this stays.
const POLL_MS = 30_000;

let rooms: readonly HqRoom[] = [];
let selected: string | null = localStorage.getItem(SELECTED_KEY);
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function parseFloorRooms(floor: readonly FloorRoom[]): HqRoom[] {
  return floor.map((room) => ({
    slug: room.slug,
    label: room.label,
    attention: room.attention ?? [],
    zone: room.zone ?? "permanent",
    agents: room.desks?.length ?? 0,
    threadIds: new Set(
      [...(room.desks ?? []), ...(room.lounge ?? [])]
        .map((desk) => desk.threadUrl?.split("/").filter(Boolean).at(-1))
        .filter((id): id is string => Boolean(id)),
    ),
  }));
}

async function refresh() {
  try {
    const response = await fetch("/hq/api/floor", { cache: "no-store" });
    if (!response.ok) return;
    rooms = parseFloorRooms(((await response.json()) as { floor: FloorRoom[] }).floor);
    emit();
  } catch {
    // HQ offline: keep the last rooms rather than flashing an empty bar.
  }
}

let pollers = 0;
function useHqRoomPolling() {
  useEffect(() => {
    if (pollers++ === 0) void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      pollers--;
      window.clearInterval(timer);
    };
  }, []);
}

export function selectHqRoom(slug: string | null) {
  selected = slug;
  if (slug) localStorage.setItem(SELECTED_KEY, slug);
  else localStorage.removeItem(SELECTED_KEY);
  emit();
}

export function useHqRooms() {
  useHqRoomPolling();
  const current = useSyncExternalStore(subscribe, () => rooms);
  const selectedSlug = useSyncExternalStore(subscribe, () => selected);
  const selectedRoom = current.find((room) => room.slug === selectedSlug) ?? null;
  return { rooms: current, selectedSlug, selectedThreadIds: selectedRoom?.threadIds ?? null };
}

type ActivityInput = {
  readonly id: string;
  readonly createdAt: string;
  readonly unsettledAt?: string | null | undefined;
  readonly latestUserMessageAt?: string | null | undefined;
  readonly latestTurn?: {
    readonly requestedAt: string;
    readonly completedAt: string | null;
  } | null;
};

const ms = (value: string | null | undefined) => (value ? Date.parse(value) || 0 : 0);

/** Latest of: you sent a message, an agent turn started or finished, the thread (re)entered the list. */
export function threadActivityMs(thread: ActivityInput): number {
  return Math.max(
    ms(thread.createdAt),
    ms(thread.unsettledAt),
    ms(thread.latestUserMessageAt),
    ms(thread.latestTurn?.requestedAt),
    ms(thread.latestTurn?.completedAt),
  );
}

export function sortThreadsByActivity<T extends ActivityInput>(threads: readonly T[]): T[] {
  return threads.toSorted(
    (left, right) =>
      threadActivityMs(right) - threadActivityMs(left) || left.id.localeCompare(right.id),
  );
}

/** One-line sidebar entry: the current room opens /rooms; sort stays inline. */
export function HqRoomBar() {
  const navigate = useNavigate();
  const { rooms: current, selectedSlug } = useHqRooms();
  const selectedLabel = current.find((room) => room.slug === selectedSlug)?.label ?? selectedSlug;
  const sortOrder = useClientSettings((s) => s.sidebarThreadSortOrder);
  const updateSettings = useUpdateClientSettings();
  const setSort = (next: SidebarThreadSortOrder) =>
    updateSettings({ sidebarThreadSortOrder: next });
  return (
    <div
      className="flex items-center gap-1 pt-1.5 text-[11px] text-muted-foreground"
      data-testid="hq-room-bar"
    >
      <button
        type="button"
        className="flex min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-foreground hover:bg-accent"
        onClick={() => void navigate({ to: "/rooms" })}
      >
        <LayoutGridIcon className="size-3 shrink-0" />
        <span className="truncate">{selectedLabel ?? "All rooms"}</span>
      </button>
      {selectedSlug ? (
        <button
          type="button"
          aria-label="Show all threads"
          className="rounded p-0.5 hover:text-foreground"
          onClick={() => selectHqRoom(null)}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
      <span className="ml-auto flex gap-1">
        {(["updated_at", "created_at"] as const).map((order) => (
          <button
            key={order}
            type="button"
            className={sortOrder === order ? "text-foreground underline" : "hover:text-foreground"}
            onClick={() => setSort(order)}
          >
            {order === "updated_at" ? "Recent" : "Created"}
          </button>
        ))}
      </span>
    </div>
  );
}
