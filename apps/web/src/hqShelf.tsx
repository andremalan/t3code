// HQ Rooms: a room's shelf, shared by the room page and the Shelf surface.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import {
  HQ_SHELF_GROUPS,
  type HqShelfGroup,
  shelfGroup,
  useHqRooms,
  useOpenShelfDoc,
  useRoomShelf,
} from "./hqRooms";
import { formatRelativeTimeLabel } from "./timestampFormat";

const BADGES: Record<HqShelfGroup, string> = {
  "Pull requests": "PR",
  Pages: "N",
  Markdown: "M",
  Other: "↗",
};

/** Grouped, searchable shelf. Files open in one of `threads`' file preview; links open a tab. */
export function HqShelfList(props: { slug: string; threads: readonly ScopedThreadRef[] }) {
  const shelf = useRoomShelf(props.slug);
  const openDoc = useOpenShelfDoc();
  const [query, setQuery] = useState("");
  const docs = shelf.data;
  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matching = (docs ?? [])
      .map((doc) => ({ ...doc, group: shelfGroup(doc) }))
      .filter((doc) => !term || `${doc.title} ${doc.group}`.toLowerCase().includes(term));
    return HQ_SHELF_GROUPS.map((group) => ({
      group,
      docs: matching.filter((doc) => doc.group === group),
    })).filter((section) => section.docs.length > 0);
  }, [query, docs]);

  return (
    <div data-testid="hq-room-shelf">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Shelf <span className="opacity-60">{docs?.length ?? ""}</span>
        </h2>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a document, PR or page"
          className="ml-auto w-56 min-w-0 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-foreground/40"
        />
      </div>
      {groups.map((section) => (
        <div key={section.group} className="mb-4">
          <h3 className="mb-1 text-2xs text-muted-foreground">{section.group}</h3>
          <ul className="flex flex-col">
            {section.docs.map((doc) => (
              <li key={doc.ref}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
                  onClick={() => openDoc(doc, props.threads)}
                >
                  <span className="w-5 shrink-0 text-center text-3xs text-muted-foreground">
                    {BADGES[section.group]}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{doc.title}</span>
                  {doc.prState ? (
                    <span className="shrink-0 text-3xs text-muted-foreground">{doc.prState}</span>
                  ) : null}
                  {doc.addedAt ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelativeTimeLabel(doc.addedAt)}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {shelf.error ? (
        <p className="text-xs text-destructive">{shelf.error}</p>
      ) : docs === null ? (
        <p className="text-xs text-muted-foreground">Loading the shelf…</p>
      ) : groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {docs.length === 0 ? "Nothing on the shelf yet." : "Nothing on the shelf matches."}
        </p>
      ) : null}
    </div>
  );
}

/** Right-panel surface: the shelf of the room this thread belongs to; files open beside it. */
export function HqShelfPanel(props: { threadRef: ScopedThreadRef | null }) {
  const { rooms, selectedSlug } = useHqRooms();
  const threadId = props.threadRef?.threadId;
  const room =
    rooms.find((candidate) => threadId && candidate.threadIds.has(threadId)) ??
    rooms.find((candidate) => candidate.slug === selectedSlug) ??
    null;

  if (room === null || props.threadRef === null) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {rooms.length === 0 ? "Loading rooms…" : "This thread isn't in a room."}
      </p>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="hq-shelf-panel">
      <Link
        to="/rooms/$slug"
        params={{ slug: room.slug }}
        className="mb-3 block text-sm font-medium hover:underline"
      >
        {room.label}
      </Link>
      <HqShelfList slug={room.slug} threads={[props.threadRef]} />
    </div>
  );
}
