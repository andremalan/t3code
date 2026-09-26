// HQ Rooms: rooms come from the local HQ app (proxied at /hq) and
// filter the sidebar by thread id. Selection is a local preference; /rooms picks it.
import type { SidebarThreadSortOrder } from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { LayoutGridIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

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

/** HQ's GET /api/rooms feed (web/lib/rooms-feed.ts). */
type FeedRoom = Omit<HqRoom, "threadIds" | "shelf"> & {
  threadIds: string[];
  shelf: Array<Omit<HqShelfDoc, "target"> & { link: string }>;
};

export function parseRoomsFeed(feed: readonly FeedRoom[]): HqRoom[] {
  return feed.map((room) => ({
    ...room,
    threadIds: new Set(room.threadIds),
    shelf: room.shelf.map(({ link, ...doc }) => ({
      ...doc,
      target: link.startsWith("/doc/") ? `/hq${link}` : /^https?:/.test(link) ? link : "",
    })),
  }));
}

const SELECTED_KEY = "hq:selected-room";
// The feed carries an ETag, so an unchanged poll is a 304 and skips the parse.
const POLL_MS = 30_000;

let rooms: readonly HqRoom[] = [];
let selected: string | null = localStorage.getItem(SELECTED_KEY);
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export type HqArchivedRoom = { slug: string; title: string; archivedAt: string };
let archived: readonly HqArchivedRoom[] = [];

let feedTag = "";

// HQ's floor shows membership changes a minute or two later, so an attach or detach stays applied
// here until the feed agrees (or still disagrees after PENDING_MS).
const PENDING_MS = 5 * 60_000;
const pendingThreads = new Map<string, { slug: string; at: number; member: boolean }>();
function withPending(next: readonly HqRoom[]): readonly HqRoom[] {
  for (const [threadId, { slug, at, member }] of pendingThreads)
    if (
      Date.now() - at > PENDING_MS ||
      next.some((room) => room.slug === slug && room.threadIds.has(threadId) === member)
    )
      pendingThreads.delete(threadId);
  return next.map((room) => {
    const changes = [...pendingThreads].filter(([, pending]) => pending.slug === room.slug);
    if (!changes.length) return room;
    const threadIds = new Set(room.threadIds);
    for (const [threadId, { member }] of changes)
      if (member) threadIds.add(threadId);
      else threadIds.delete(threadId);
    return { ...room, threadIds };
  });
}

async function refresh() {
  try {
    const response = await fetch("/hq/api/rooms", { cache: "no-cache" });
    const tag = response.headers.get("etag") ?? "";
    if (!response.ok || (tag && tag === feedTag)) return;
    const feed = (await response.json()) as { rooms: FeedRoom[]; archived: HqArchivedRoom[] };
    rooms = withPending(parseRoomsFeed(feed.rooms));
    archived = feed.archived;
    feedTag = tag;
    emit();
  } catch {
    // HQ offline: keep the last rooms rather than flashing an empty bar.
  }
}

async function postHq<T = {}>(path: string, body: unknown): Promise<T & { said?: string }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as T & {
    ok?: boolean;
    error?: string;
    said?: string;
  };
  if (!response.ok || !result.ok)
    throw new Error(result.error || `HQ refused (${response.status}).`);
  return result;
}

export const HQ_ZONES = ["today", "permanent", "backlog"] as const;

/** The HQ room order after moving one room before another, or to the end of a section. */
export function moveRoomOrder(
  current: readonly Pick<HqRoom, "slug" | "zone">[],
  slug: string,
  zone: HqRoom["zone"],
  before: string | null = null,
): Record<HqRoom["zone"], string[]> {
  const moved = current.filter((room) => room.slug !== slug);
  return Object.fromEntries(
    HQ_ZONES.map((name) => {
      const slugs = moved.filter((room) => room.zone === name).map((room) => room.slug);
      if (name === zone) {
        const at = before ? slugs.indexOf(before) : -1;
        slugs.splice(at < 0 ? slugs.length : at, 0, slug);
      }
      return [name, slugs];
    }),
  ) as Record<HqRoom["zone"], string[]>;
}

/** Moves a room now (before another room, or to the end of a section); reverts if HQ refuses. */
export async function moveHqRoom(slug: string, zone: HqRoom["zone"], before: string | null = null) {
  const bySlug = new Map(rooms.map((room) => [room.slug, room]));
  if (!bySlug.has(slug) || before === slug) return;
  const previous = rooms;
  const order = moveRoomOrder(rooms, slug, zone, before);
  const next = HQ_ZONES.flatMap((name) =>
    order[name].map((each) => ({ ...bySlug.get(each)!, zone: name })),
  );
  if (
    next.every((room, index) => room.slug === rooms[index]?.slug && room.zone === rooms[index].zone)
  )
    return;
  rooms = next;
  emit();
  try {
    await postHq("/hq/api/rooms", order);
  } catch (error) {
    rooms = previous;
    emit();
    throw error;
  }
}

/** Adds a T3 thread to a room, or removes it, now (HQ acts on the thread's session); reverts if HQ refuses. */
export async function setHqThreadRoom(slug: string, threadId: string, member: boolean) {
  const previous = pendingThreads.get(threadId);
  pendingThreads.set(threadId, { slug, at: Date.now(), member });
  rooms = withPending(rooms);
  emit();
  try {
    await postHq(`/hq/api/room/${encodeURIComponent(slug)}`, {
      action: member ? "attach" : "detach",
      thread: threadId,
    });
  } catch (error) {
    if (previous) pendingThreads.set(threadId, previous);
    else pendingThreads.delete(threadId);
    rooms = rooms.map((room) => {
      if (room.slug !== slug) return room;
      const threadIds = new Set(room.threadIds);
      if (member) threadIds.delete(threadId);
      else threadIds.add(threadId);
      return { ...room, threadIds };
    });
    emit();
    throw error;
  }
}

export type HqModel = { model: string; engine: string };
export async function hqRoomModels(slug: string): Promise<HqModel[]> {
  const response = await fetch(`/hq/api/room/${encodeURIComponent(slug)}`);
  if (!response.ok) throw new Error(`HQ refused (${response.status}).`);
  const room = (await response.json()) as { context?: { agentCatalog?: { models?: HqModel[] } } };
  return room.context?.agentCatalog?.models ?? [];
}

/** Starts a fresh agent that continues the thread's recorded state; HQ retitles the old thread. */
export async function replaceHqThread(slug: string, threadId: string, model: string) {
  const { result } = await postHq<{ result: { thread: string; titleWarning?: string } }>(
    `/hq/api/room/${encodeURIComponent(slug)}`,
    { action: "replace", thread: threadId, ...(model ? { model } : {}) },
  );
  // The replacement joins the room; show it before the floor does.
  pendingThreads.set(result.thread, { slug, at: Date.now(), member: true });
  rooms = withPending(rooms);
  emit();
  return result;
}

export async function archiveHqRoom(slug: string): Promise<string> {
  const { said = "" } = await postHq(`/hq/api/room/${encodeURIComponent(slug)}`, {
    action: "archive",
    reason: "Archived from the rooms overview",
  });
  if (selected === slug) selectHqRoom(null);
  await refresh();
  return said;
}

export async function unarchiveHqRoom(slug: string): Promise<string> {
  const { said = "" } = await postHq(`/hq/api/room/${encodeURIComponent(slug)}`, {
    action: "unarchive",
  });
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

/** Live, unsettled threads that no room holds, most recently active first. */
export function hqUnroomedThreads(
  rooms: readonly HqRoom[],
  threads: readonly SidebarThreadSummary[],
): SidebarThreadSummary[] {
  return hqRoomThreads(null, threads).filter(
    (thread) =>
      thread.settledOverride !== "settled" && !rooms.some((room) => room.threadIds.has(thread.id)),
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

/** Sidebar header links: all rooms, and the open thread's room when it has one. */
export function HqRoomsLink({ onBackdrop }: { onBackdrop: boolean }) {
  const { threadId } = useParams({ strict: false });
  const { rooms: current } = useHqRooms();
  const room = threadId ? current.find((each) => each.threadIds.has(threadId)) : undefined;
  const link = cn(
    "shrink-0 truncate rounded-md px-1 text-xs outline-hidden ring-ring focus-visible:ring-2",
    onBackdrop ? "text-white/70 hover:text-white" : "text-muted-foreground hover:text-foreground",
  );
  return (
    <span
      className="relative z-10 ml-2 hidden min-w-0 items-center md:flex"
      data-testid="hq-rooms-link"
    >
      <Link to="/rooms" className={link}>
        Rooms
      </Link>
      {room ? (
        <>
          <span className={onBackdrop ? "text-white/50" : "text-muted-foreground/60"}>/</span>
          <Link
            to="/rooms/$slug"
            params={{ slug: room.slug }}
            className={cn(link, "min-w-0 shrink")}
          >
            {room.label}
          </Link>
        </>
      ) : null}
    </span>
  );
}

/** Hover actions for a thread row in a room. Put inside a relative `group/row` element. */
export function HqThreadActions({
  slug,
  thread,
  onStatus,
}: {
  slug: string;
  thread: Pick<SidebarThreadSummary, "id" | "environmentId" | "title">;
  onStatus: (message: string) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const button = "rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground";
  return (
    <span className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 rounded-md bg-accent pl-1 opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
      <button
        type="button"
        aria-label="Replace agent"
        title="Replace with a fresh agent"
        className={button}
        onClick={() => setReplacing(true)}
      >
        <RefreshCwIcon className="size-3" />
      </button>
      <button
        type="button"
        aria-label="Remove from room"
        title="Remove from room"
        className={button}
        onClick={() =>
          setHqThreadRoom(slug, thread.id, false).then(
            () => onStatus(`Removed ${thread.title} from the room.`),
            (error: unknown) => onStatus(error instanceof Error ? error.message : String(error)),
          )
        }
      >
        <XIcon className="size-3" />
      </button>
      {replacing ? (
        <HqReplaceDialog
          slug={slug}
          thread={thread}
          onClose={() => setReplacing(false)}
          onStatus={onStatus}
        />
      ) : null}
    </span>
  );
}

function HqReplaceDialog({
  slug,
  thread,
  onClose,
  onStatus,
}: {
  slug: string;
  thread: Pick<SidebarThreadSummary, "id" | "environmentId" | "title">;
  onClose: () => void;
  onStatus: (message: string) => void;
}) {
  const navigate = useNavigate();
  const [models, setModels] = useState<HqModel[] | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    hqRoomModels(slug).then(setModels, () => setModels([]));
  }, [slug]);
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            replaceHqThread(slug, thread.id, model).then(
              (result) => {
                onClose();
                if (result.titleWarning) onStatus(result.titleWarning);
                selectHqRoom(slug);
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId: thread.environmentId, threadId: result.thread },
                });
              },
              (failure: unknown) => {
                setBusy(false);
                setError(failure instanceof Error ? failure.message : String(failure));
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Replace agent</DialogTitle>
            <DialogDescription>
              Starts a fresh agent in this room that continues from {thread.title}&apos;s recorded
              state. The old thread stays in history with a Replaced title.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-2 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Model</span>
              <select
                className="h-8 rounded-md border border-input bg-background px-2"
                value={model}
                disabled={busy}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="">Keep current model (latest version)</option>
                {models?.map((each) => (
                  <option key={each.model} value={each.model}>
                    {each.model} ({each.engine})
                  </option>
                ))}
              </select>
            </label>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Starting…" : "Replace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
