// HQ Rooms: rooms, their shelves and notes live on the primary T3 server; rooms filter the
// sidebar by thread id. Selection is a local preference; /rooms picks it.
import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  RoomList,
  RoomNote,
  RoomSection,
  RoomShelfDoc,
  ScopedThreadRef,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import { ROOM_SECTIONS, ThreadId } from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  CheckIcon,
  ChevronDownIcon,
  LayoutGridIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
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
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { ComposerControl } from "~/components/chat/ComposerControl";
import { useComposerMenuProps } from "~/components/chat/composerEventScope";
import { cn } from "~/lib/utils";

import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { useUiStateStore } from "~/uiStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { roomsEnvironment } from "~/state/rooms";
import { useEnvironmentQuery } from "~/state/query";
import { environmentServerConfigsAtom, primaryServerProvidersAtom } from "~/state/server";
import type { SidebarThreadSummary } from "~/types";

export type HqRoom = {
  slug: string;
  label: string;
  outcome: string;
  note: RoomNote | null;
  zone: RoomSection;
  threadIds: ReadonlySet<string>;
};

export const HQ_SHELF_GROUPS = ["Pull requests", "Pages", "Markdown", "Other"] as const;
export type HqShelfGroup = (typeof HQ_SHELF_GROUPS)[number];

/** HQ's shelf groups (web/lib/shelf.ts), by recorded kind or by the ref's shape. */
export function shelfGroup(doc: Pick<RoomShelfDoc, "ref" | "kind">): HqShelfGroup {
  const ref = doc.ref.toLowerCase();
  if (doc.kind === "pr" || /\/pull\/\d+|\/github\/pr\//.test(ref)) return "Pull requests";
  if (doc.kind === "page" || ref.endsWith(".html") || /notion\.(so|com)\//.test(ref))
    return "Pages";
  if (doc.kind === "md" || ref.endsWith(".md")) return "Markdown";
  return "Other";
}

export type HqArchivedRoom = { slug: string; title: string; archivedAt: string };

const EMPTY_ROOMS: RoomList = [];

/** Every room on the primary server, archived ones included; empty on servers without rooms. */
const roomListAtom = Atom.make((get): RoomList => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (
    !environmentId ||
    get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities.rooms !== true
  )
    return EMPTY_ROOMS;
  const result = get(roomsEnvironment.rooms({ environmentId, input: {} }));
  return Option.getOrElse(AsyncResult.value(result), () => EMPTY_ROOMS);
}).pipe(Atom.withLabel("hq-room-list"));

const roomsAtom = Atom.make((get) => {
  const list = get(roomListAtom);
  return {
    rooms: list
      .filter((room) => room.archivedAt === null)
      .map((room): HqRoom => ({
        slug: room.slug,
        label: room.title,
        outcome: room.outcome,
        note: room.note,
        zone: room.section,
        threadIds: new Set(room.threadIds),
      })),
    archived: list
      .flatMap((room): HqArchivedRoom[] =>
        room.archivedAt
          ? [{ slug: room.slug, title: room.title, archivedAt: room.archivedAt }]
          : [],
      )
      .toSorted((left, right) => right.archivedAt.localeCompare(left.archivedAt)),
  };
}).pipe(Atom.withLabel("hq-rooms"));

const SELECTED_KEY = "hq:selected-room";

let selected: string | null = localStorage.getItem(SELECTED_KEY);
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

async function runRooms<I, A, E>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
  input: I,
): Promise<A> {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (!environmentId) throw new Error("Rooms need a connected T3 server.");
  const result = await runAtomCommand(
    appAtomRegistry,
    command,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export const HQ_ZONES = ROOM_SECTIONS;
export const HQ_ZONE_TITLES = [
  ["today", "Today"],
  ["permanent", "Permanent"],
  ["backlog", "Backlog"],
] as const satisfies ReadonlyArray<readonly [RoomSection, string]>;

/** The room order after moving one room before another, or to the end of a section. */
export function moveRoomOrder(
  current: readonly Pick<HqRoom, "slug" | "zone">[],
  slug: string,
  zone: RoomSection,
  before: string | null = null,
): Record<RoomSection, string[]> {
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
  ) as Record<RoomSection, string[]>;
}

/** Moves a room before another room, or to the end of a section. Archived rooms keep their place. */
export async function moveHqRoom(slug: string, zone: RoomSection, before: string | null = null) {
  const { rooms } = appAtomRegistry.get(roomsAtom);
  if (!rooms.some((room) => room.slug === slug) || before === slug) return;
  const order = moveRoomOrder(rooms, slug, zone, before);
  const next = HQ_ZONES.flatMap((name) => order[name].map((each) => `${name}:${each}`));
  if (next.join() === rooms.map((room) => `${room.zone}:${room.slug}`).join()) return;
  await runRooms(roomsEnvironment.reorder, order);
}

/** Adds a T3 thread to a room, or removes it. */
export async function setHqThreadRoom(slug: string, threadId: string, member: boolean) {
  await runRooms(roomsEnvironment.setThread, { slug, threadId: ThreadId.make(threadId), member });
}

/**
 * Replace: a fresh thread in the same checkout and rooms takes over from `threadId`, seeded with a
 * handoff, and the old thread settles. Keeps the old model unless one is given.
 */
export async function replaceHqThread(threadId: string, modelSelection?: ModelSelection) {
  return runRooms(roomsEnvironment.replaceThread, {
    threadId: ThreadId.make(threadId),
    ...(modelSelection ? { modelSelection } : {}),
  });
}

export const hqSlug = (title: string) =>
  title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/, "");

/** Creates an empty room at the end of a section; resolves to its slug. */
export async function createHqRoom(title: string, outcome: string, zone: RoomSection) {
  const slug = hqSlug(title);
  if (!slug) throw new Error("Give the room a name with letters or numbers.");
  await runRooms(roomsEnvironment.create, { slug, title: title.trim(), outcome, section: zone });
  return slug;
}

/**
 * Replaces a room's note from a client; an empty note clears it. `basedOn` is the revision the
 * editor opened (null for no note); the server refuses the write if a thread changed it meanwhile.
 */
export async function setHqRoomNote(slug: string, note: string, basedOn: number | null) {
  await runRooms(roomsEnvironment.update, { slug, note, noteBasedOn: basedOn });
}

/**
 * Renames a room or edits its outcome; the slug stays, so links and memberships hold. Pass only
 * the fields that changed, so a concurrent edit to the other one survives.
 */
export async function updateHqRoom(
  slug: string,
  details: { readonly title?: string; readonly outcome?: string },
) {
  await runRooms(roomsEnvironment.update, {
    slug,
    ...(details.title !== undefined ? { title: details.title.trim() } : {}),
    ...(details.outcome !== undefined ? { outcome: details.outcome.trim() } : {}),
  });
}

export async function archiveHqRoom(slug: string) {
  await runRooms(roomsEnvironment.update, { slug, archived: true });
  if (selected === slug) selectHqRoom(null);
}

export async function unarchiveHqRoom(slug: string) {
  await runRooms(roomsEnvironment.update, { slug, archived: false });
}

/** A room's shelf, newest first; read when shown, never pushed. */
export function useRoomShelf(slug: string | null) {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  return useEnvironmentQuery(
    slug && environmentId ? roomsEnvironment.shelf({ environmentId, input: { slug } }) : null,
  );
}

/**
 * Links open a tab. Files open in a thread's file preview: the doc's own thread when it is among
 * `threads`, else the first of them.
 */
export function useOpenShelfDoc() {
  const navigate = useNavigate();
  return (doc: RoomShelfDoc, threads: readonly ScopedThreadRef[]) => {
    if (!doc.ref.startsWith("/")) {
      window.open(doc.ref, "_blank", "noopener,noreferrer");
      return;
    }
    const thread = threads.find((each) => each.threadId === doc.threadId) ?? threads[0];
    if (!thread) return;
    useRightPanelStore.getState().openFile(thread, doc.ref);
    void navigate({ to: "/$environmentId/$threadId", params: thread });
  };
}

/** Filters the sidebar to a room. Rooms span projects, so a room also clears the project scope. */
export function selectHqRoom(slug: string | null) {
  selected = slug;
  if (slug) {
    localStorage.setItem(SELECTED_KEY, slug);
    useUiStateStore.getState().setSidebarProjectScopeKey(null);
  } else localStorage.removeItem(SELECTED_KEY);
  listeners.forEach((listener) => listener());
}

export function useHqRooms() {
  const { rooms, archived } = useAtomValue(roomsAtom);
  const selectedSlug = useSyncExternalStore(subscribe, () => selected);
  const selectedRoom = rooms.find((room) => room.slug === selectedSlug) ?? null;
  return {
    rooms,
    archivedRooms: archived,
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

/**
 * A room's unsettled threads (all of them for null), most recently active first. Settling a thread
 * is how it leaves a room's working set; the sidebar still lists it under Settled.
 */
export function hqRoomThreads(
  room: HqRoom | null,
  threads: readonly SidebarThreadSummary[],
  { includeSettled = false } = {},
): SidebarThreadSummary[] {
  return sortThreadsByActivity(
    threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        (includeSettled || thread.settledOverride !== "settled") &&
        (room === null || room.threadIds.has(thread.id)),
    ),
  );
}

/** Unsettled threads that no room holds, most recently active first. */
export function hqUnroomedThreads(
  rooms: readonly HqRoom[],
  threads: readonly SidebarThreadSummary[],
): SidebarThreadSummary[] {
  return hqRoomThreads(null, threads).filter(
    (thread) => !rooms.some((room) => room.threadIds.has(thread.id)),
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

// Drafts already defaulted to the sidebar's room, so choosing "No room" sticks.
const defaultedDrafts = new Set<string>();

/**
 * Composer strip control: the room this thread works in. Picking one moves the thread there (a
 * thread normally sits in one room). A new draft joins the room the sidebar is filtered to; its
 * thread keeps the draft's id, so membership is set before the first send.
 */
export function HqRoomPicker({ threadId, isDraft }: { threadId: string; isDraft: boolean }) {
  const { rooms, selectedSlug } = useHqRooms();
  const menuProps = useComposerMenuProps();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const current = rooms.filter((room) => room.threadIds.has(threadId));
  const roomsLoaded = rooms.length > 0;

  useEffect(() => {
    if (!isDraft || !selectedSlug || !roomsLoaded || defaultedDrafts.has(threadId)) return;
    defaultedDrafts.add(threadId);
    if (current.length === 0) void setHqThreadRoom(selectedSlug, threadId, true);
  }, [current.length, isDraft, roomsLoaded, selectedSlug, threadId]);

  const moveTo = (slug: string | null) => {
    setError("");
    Promise.all([
      ...current
        .filter((room) => room.slug !== slug)
        .map((room) => setHqThreadRoom(room.slug, threadId, false)),
      ...(slug && !current.some((room) => room.slug === slug)
        ? [setHqThreadRoom(slug, threadId, true)]
        : []),
    ]).catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  };

  if (!roomsLoaded) return null;
  const label = current.map((room) => room.label).join(", ") || "No room";
  return (
    <>
      <Menu>
        <MenuTrigger
          render={<ComposerControl size="xs" />}
          className="min-w-0 max-w-[30%] flex-initial justify-start"
          aria-label="Room"
          data-composer-context-control
        >
          <LayoutGridIcon className="size-3 shrink-0" />
          <span className={cn("min-w-0 truncate", error && "text-destructive")}>
            {error ? "Room change failed" : label}
          </span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
        </MenuTrigger>
        <MenuPopup align="start" side="top" className="max-h-80" {...menuProps}>
          <MenuGroup>
            <MenuGroupLabel>Room</MenuGroupLabel>
            <MenuRadioGroup
              value={current.length === 1 ? current[0]!.slug : current.length === 0 ? "" : null}
              onValueChange={(value: string) => moveTo(value || null)}
            >
              {rooms.map((room) => (
                <MenuRadioItem key={room.slug} value={room.slug}>
                  {room.label}
                </MenuRadioItem>
              ))}
              <MenuRadioItem value="">No room</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={() => setCreating(true)}>
            <PlusIcon className="size-3" />
            New room…
          </MenuItem>
        </MenuPopup>
      </Menu>
      {creating ? <HqNewRoomDialog onClose={() => setCreating(false)} onCreated={moveTo} /> : null}
    </>
  );
}

/** Hover actions for a thread row in a room. Put inside a relative `group/row` element. */
export function HqThreadActions({
  slug,
  thread,
  onSettle,
  onStatus,
}: {
  slug: string;
  thread: Pick<SidebarThreadSummary, "id" | "environmentId" | "title">;
  onSettle: () => void;
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
      <button type="button" aria-label="Settle thread" className={button} onClick={onSettle}>
        <CheckIcon className="size-3" />
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
  const providers = useAtomValue(primaryServerProvidersAtom);
  const models = providers
    .filter((provider) => provider.enabled && provider.installed)
    .flatMap((provider) =>
      provider.models.map((option) => ({
        key: `${provider.instanceId}\u0000${option.slug}`,
        label: `${provider.displayName ?? provider.instanceId} · ${option.name}`,
        selection: { instanceId: provider.instanceId, model: option.slug } as ModelSelection,
      })),
    );
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            replaceHqThread(
              thread.id,
              models.find((option) => option.key === model)?.selection,
            ).then(
              (result) => {
                onClose();
                onStatus(`Replaced ${thread.title}; the old thread is settled.`);
                selectHqRoom(slug);
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId: thread.environmentId, threadId: result.threadId },
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
              Forks {thread.title} into a fresh agent in the same worktree and rooms. The
              conversation carries over, the agent gets the room note, and the old thread is
              settled.
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
                <option value="">Keep the current model</option>
                {models.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
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

/** Creates a room; `onCreated` gets its slug. */
export function HqNewRoomDialog(props: { onClose: () => void; onCreated: (slug: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setBusy(true);
            setError("");
            createHqRoom(
              String(data.get("name")).trim(),
              String(data.get("outcome") ?? "").trim(),
              data.get("zone") as RoomSection,
            ).then(
              (slug) => {
                props.onClose();
                props.onCreated(slug);
              },
              (failure: unknown) => {
                setBusy(false);
                setError(failure instanceof Error ? failure.message : String(failure));
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>New room</DialogTitle>
            <DialogDescription>
              Creates an empty room. Add threads from the composer or the rooms overview.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Name</span>
              <input
                name="name"
                required
                maxLength={120}
                autoFocus
                disabled={busy}
                className="h-8 rounded-md border border-input bg-background px-2"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Outcome (optional)</span>
              <textarea
                name="outcome"
                maxLength={500}
                rows={3}
                disabled={busy}
                className="rounded-md border border-input bg-background px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Section</span>
              <select
                name="zone"
                defaultValue="today"
                disabled={busy}
                className="h-8 rounded-md border border-input bg-background px-2"
              >
                {HQ_ZONE_TITLES.map(([zone, title]) => (
                  <option key={zone} value={zone}>
                    {title}
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
            <Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
