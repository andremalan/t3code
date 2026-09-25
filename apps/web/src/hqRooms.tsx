// HQ Rooms: rooms come from the local HQ app (proxied at /hq) and
// filter the sidebar by thread id. Selection is a local preference; /rooms picks it.
import type { SidebarThreadSortOrder } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LayoutGridIcon, XIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import type { SidebarThreadSummary } from "~/types";

export type HqRoom = {
  slug: string;
  label: string;
  /** HQ's own attention flags, e.g. "direct-done". */
  attention: readonly string[];
  zone: "today" | "backlog" | "permanent";
  /** Seated (non-lounge) agents. */
  agents: number;
  threadIds: ReadonlySet<string>;
  /** Newest first. */
  shelf: readonly HqShelfDoc[];
};

export const HQ_SHELF_GROUPS = ["Pull requests", "Pages", "Markdown", "Other links"] as const;
export type HqShelfDoc = {
  name: string;
  /** Same-origin `/hq/doc/...` reader URL, an external URL, or "" when HQ can't serve it. */
  target: string;
  group: (typeof HQ_SHELF_GROUPS)[number];
  by: string;
  ts: string;
  prStatus?: string;
  localPath?: string;
};

type FloorDoc = {
  name: string;
  url?: string;
  href?: string;
  ref?: string;
  kind?: string;
  by?: string;
  ts?: string;
  prStatus?: string;
  localPath?: string;
};
type FloorDesk = { uuid?: string; name?: string; threadUrl?: string; docs?: FloorDoc[] };
type FloorRoom = {
  slug: string;
  label: string;
  attention?: string[];
  zone?: HqRoom["zone"];
  desks?: FloorDesk[];
  lounge?: FloorDesk[];
  orphanDocs?: FloorDoc[];
};

// Mirrors web/lib/shelf.ts in HQ: recorded kind first, then what the link says.
function shelfGroup(doc: FloorDoc, link: string): HqShelfDoc["group"] {
  const target = link.toLowerCase();
  if (
    doc.kind === "pr" ||
    /github\.com\/[^/]+\/[^/]+\/pull\/\d+|graphite\.com\/github\/pr\//.test(target)
  )
    return "Pull requests";
  if (doc.kind === "page" || target.endsWith(".html") || /notion\.(so|com)/.test(target))
    return "Pages";
  if (doc.kind === "md" || target.endsWith(".md")) return "Markdown";
  return "Other links";
}

function parseShelf(room: FloorRoom): HqShelfDoc[] {
  const desks = [...(room.desks ?? []), ...(room.lounge ?? [])];
  const names = new Map(desks.map((desk) => [desk.uuid, desk.name ?? ""]));
  const entries = [
    ...desks.flatMap((desk) => (desk.docs ?? []).map((doc) => ({ doc, by: desk.name ?? "" }))),
    ...(room.orphanDocs ?? []).map((doc) => ({ doc, by: names.get(doc.by) ?? "" })),
  ];
  const byTarget = new Map<string, HqShelfDoc>();
  for (const { doc, by } of entries) {
    const link = doc.href || doc.url || doc.ref || "";
    const target = link.startsWith("/doc/") ? `/hq${link}` : /^https?:/.test(link) ? link : "";
    const key = link || doc.name;
    if (byTarget.has(key)) continue;
    byTarget.set(key, {
      name: doc.name,
      target,
      group: shelfGroup(doc, link),
      by,
      ts: doc.ts ?? "",
      ...(doc.prStatus ? { prStatus: doc.prStatus } : {}),
      ...(doc.localPath ? { localPath: doc.localPath } : {}),
    });
  }
  return [...byTarget.values()].toSorted((a, b) => b.ts.localeCompare(a.ts));
}

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
    shelf: parseShelf(room),
    agents: room.desks?.length ?? 0,
    threadIds: new Set(
      [...(room.desks ?? []), ...(room.lounge ?? [])]
        .map((desk) => desk.threadUrl?.split("/").filter(Boolean).at(-1))
        .filter((id): id is string => Boolean(id)),
    ),
  }));
}

export type HqArchivedRoom = { slug: string; title: string; archivedAt: string };
let archived: readonly HqArchivedRoom[] = [];

async function getHq<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(path, { cache: "no-store" });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

async function refresh() {
  const [floor, archive] = await Promise.all([
    getHq<{ floor: FloorRoom[] }>("/hq/api/floor"),
    getHq<{ archived: HqArchivedRoom[] }>("/hq/api/rooms"),
  ]);
  // HQ offline: keep the last rooms rather than flashing an empty bar.
  if (floor) rooms = parseFloorRooms(floor.floor);
  if (archive) archived = archive.archived;
  emit();
}

async function postHq(path: string, body: unknown): Promise<string> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    said?: string;
  };
  if (!response.ok || !result.ok)
    throw new Error(result.error || `HQ refused (${response.status}).`);
  return result.said ?? "";
}

export const HQ_ZONES = ["today", "permanent", "backlog"] as const;

/** The HQ room order after moving one room to the end of a section. */
export function moveRoomOrder(
  current: readonly Pick<HqRoom, "slug" | "zone">[],
  slug: string,
  zone: HqRoom["zone"],
): Record<HqRoom["zone"], string[]> {
  const moved = current.filter((room) => room.slug !== slug);
  return Object.fromEntries(
    HQ_ZONES.map((name) => [
      name,
      [
        ...moved.filter((room) => room.zone === name).map((room) => room.slug),
        ...(name === zone ? [slug] : []),
      ],
    ]),
  ) as Record<HqRoom["zone"], string[]>;
}

/** Moves a room to another section now; reverts if HQ refuses. */
export async function moveHqRoom(slug: string, zone: HqRoom["zone"]) {
  const room = rooms.find((candidate) => candidate.slug === slug);
  if (!room || room.zone === zone) return;
  const previous = rooms;
  const order = moveRoomOrder(rooms, slug, zone);
  rooms = [...rooms.filter((candidate) => candidate.slug !== slug), { ...room, zone }];
  emit();
  try {
    await postHq("/hq/api/rooms", order);
  } catch (error) {
    rooms = previous;
    emit();
    throw error;
  }
}

export async function archiveHqRoom(slug: string): Promise<string> {
  const said = await postHq(`/hq/api/room/${encodeURIComponent(slug)}`, {
    action: "archive",
    reason: "Archived from the rooms overview",
  });
  if (selected === slug) selectHqRoom(null);
  await refresh();
  return said;
}

export async function unarchiveHqRoom(slug: string): Promise<string> {
  const said = await postHq(`/hq/api/room/${encodeURIComponent(slug)}`, { action: "unarchive" });
  await refresh();
  return said;
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
  const archivedRooms = useSyncExternalStore(subscribe, () => archived);
  const selectedRoom = current.find((room) => room.slug === selectedSlug) ?? null;
  return {
    rooms: current,
    archivedRooms,
    selectedSlug,
    selectedThreadIds: selectedRoom?.threadIds ?? null,
  };
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

// Mirrors server/status/collect.ts in HQ.
export const HQ_ATTENTION_LABELS: Record<string, string> = {
  decision: "Decision",
  task: "Task",
  blocked: "Blocked",
  "direct-done": "New result",
};

/** A room's live threads (all live threads for null), most recently active first. */
export function hqRoomThreads(
  room: HqRoom | null,
  threads: readonly SidebarThreadSummary[],
): SidebarThreadSummary[] {
  return sortThreadsByActivity(
    threads.filter(
      (thread) => thread.archivedAt === null && (room === null || room.threadIds.has(thread.id)),
    ),
  );
}

/** Filter the sidebar to a room and open a thread in it; false when there is none. */
export function useOpenHqRoom() {
  const navigate = useNavigate();
  return (slug: string | null, thread: SidebarThreadSummary | undefined) => {
    selectHqRoom(slug);
    if (!thread) return false;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: thread.environmentId, threadId: thread.id },
    });
    return true;
  };
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
        onClick={() =>
          void (selectedSlug
            ? navigate({ to: "/rooms/$slug", params: { slug: selectedSlug } })
            : navigate({ to: "/rooms" }))
        }
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
