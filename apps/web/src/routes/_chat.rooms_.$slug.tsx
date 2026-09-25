// HQ Rooms spike: one room's page. Visiting it filters the sidebar to the room;
// it lists the room's threads and shelf, and reads HQ documents in place.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { resolveThreadStatusPill } from "../components/Sidebar.logic";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import {
  HQ_ATTENTION_LABELS,
  HQ_SHELF_GROUPS,
  type HqShelfDoc,
  hqRoomThreads,
  selectHqRoom,
  threadActivityMs,
  useHqRooms,
  useOpenHqRoom,
} from "../hqRooms";
import { cn } from "../lib/utils";
import { useThreadShells } from "../state/entities";
import { formatRelativeTimeLabel } from "../timestampFormat";

type RoomSearch = { doc?: string };

const BADGES: Record<HqShelfDoc["group"], string> = {
  "Pull requests": "PR",
  Pages: "N",
  Markdown: "M",
  "Other links": "↗",
};
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
  const [query, setQuery] = useState("");
  const shelfGroups = useMemo(() => {
    const term = query.trim().toLowerCase();
    const docs = (room?.shelf ?? []).filter(
      (entry) => !term || `${entry.name} ${entry.by} ${entry.group}`.toLowerCase().includes(term),
    );
    return HQ_SHELF_GROUPS.map((group) => ({
      group,
      docs: docs.filter((entry) => entry.group === group),
    })).filter((section) => section.docs.length > 0);
  }, [query, room]);
  const openDoc = room?.shelf.find((entry) => entry.target === doc) ?? null;

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

  const pickDoc = (entry: HqShelfDoc) => {
    if (entry.target.startsWith("/hq/")) setDoc(entry.target);
    else if (entry.target) window.open(entry.target, "_blank", "noopener,noreferrer");
  };

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
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              "min-h-0 overflow-y-auto p-4 sm:p-6",
              openDoc ? "w-[26rem] shrink-0 border-r border-border" : "mx-auto w-full max-w-3xl",
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
                      <li key={`${thread.environmentId}:${thread.id}`}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
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
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {relative(threadActivityMs(thread))}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Shelf <span className="opacity-60">{room.shelf.length}</span>
                  </h2>
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Find a document, PR or page"
                    className="ml-auto w-56 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-foreground/40"
                  />
                </div>
                <div data-testid="hq-room-shelf">
                  {shelfGroups.map((section) => (
                    <div key={section.group} className="mb-4">
                      <h3 className="mb-1 text-[11px] text-muted-foreground">{section.group}</h3>
                      <ul className="flex flex-col">
                        {section.docs.map((entry) => (
                          <li key={entry.target || entry.name}>
                            <button
                              type="button"
                              disabled={!entry.target}
                              title={entry.target ? undefined : entry.localPath}
                              className={cn(
                                "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent disabled:opacity-50",
                                entry.target === doc && "bg-accent",
                              )}
                              onClick={() => pickDoc(entry)}
                            >
                              <span className="w-5 shrink-0 text-center text-[10px] text-muted-foreground">
                                {BADGES[entry.group]}
                              </span>
                              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                              {entry.prStatus ? (
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                  {entry.prStatus}
                                </span>
                              ) : null}
                              {entry.ts ? (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {relative(Date.parse(entry.ts))}
                                </span>
                              ) : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {shelfGroups.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Nothing on the shelf matches.</p>
                  ) : null}
                </div>
              </>
            )}
          </div>
          {openDoc ? (
            <div className="flex min-w-0 flex-1 flex-col" data-testid="hq-doc-reader">
              <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{openDoc.name}</span>
                <a
                  href={openDoc.target}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open in new tab"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ExternalLinkIcon className="size-4" />
                </a>
                <button
                  type="button"
                  aria-label="Close document"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setDoc(undefined)}
                >
                  <XIcon className="size-4" />
                </button>
              </div>
              {/* Same-origin via the /hq proxy: no scripts, so a shelf page can't act as T3. */}
              <iframe
                title={openDoc.name}
                src={openDoc.target}
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                className="min-h-0 flex-1 bg-white"
              />
            </div>
          ) : null}
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
