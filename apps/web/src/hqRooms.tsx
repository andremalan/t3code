// HQ Rooms spike: rooms come from the local HQ app (proxied at /hq in dev) and
// filter the sidebar by thread id. Selection is a local preference.
import type { SidebarThreadSortOrder } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";

export type HqRoom = { slug: string; label: string; threadIds: ReadonlySet<string> };

type FloorRoom = {
  slug: string;
  label: string;
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

const chip =
  "rounded-md border px-1.5 py-0.5 text-[11px] leading-4 whitespace-nowrap transition-colors";
const chipOn = "border-primary/60 bg-primary/10 text-foreground";
const chipOff = "border-border text-muted-foreground hover:text-foreground";

export function HqRoomBar(props: { visibleThreadIds: ReadonlySet<string> }) {
  const { rooms: current, selectedSlug } = useHqRooms();
  const sortOrder = useClientSettings((s) => s.sidebarThreadSortOrder);
  const updateSettings = useUpdateClientSettings();
  const setSort = (next: SidebarThreadSortOrder) =>
    updateSettings({ sidebarThreadSortOrder: next });
  const counted = current
    .map((room) => ({
      room,
      count: [...room.threadIds].filter((id) => props.visibleThreadIds.has(id)).length,
    }))
    .filter(({ room, count }) => count > 0 || room.slug === selectedSlug);
  return (
    <div className="flex flex-col gap-1 pt-1.5" data-testid="hq-room-bar">
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className={`${chip} ${selectedSlug === null ? chipOn : chipOff}`}
          onClick={() => selectHqRoom(null)}
        >
          All threads
        </button>
        {counted.map(({ room, count }) => (
          <button
            key={room.slug}
            type="button"
            className={`${chip} ${selectedSlug === room.slug ? chipOn : chipOff}`}
            onClick={() => selectHqRoom(selectedSlug === room.slug ? null : room.slug)}
          >
            {room.label} <span className="opacity-60">{count}</span>
          </button>
        ))}
      </div>
      <div className="flex gap-1 text-[11px] text-muted-foreground">
        Sort:
        {(["updated_at", "created_at"] as const).map((order) => (
          <button
            key={order}
            type="button"
            className={sortOrder === order ? "text-foreground underline" : "hover:text-foreground"}
            onClick={() => setSort(order)}
          >
            {order === "updated_at" ? "Recent activity" : "Created"}
          </button>
        ))}
      </div>
    </div>
  );
}
