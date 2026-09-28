// HQ Rooms spike: a room's shelf, shared by the room page and the Shelf surface.
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { HQ_SHELF_GROUPS, type HqShelfDoc, useHqRooms } from "./hqRooms";
import { cn } from "./lib/utils";
import { formatRelativeTimeLabel } from "./timestampFormat";

const BADGES: Record<HqShelfDoc["group"], string> = {
  "Pull requests": "PR",
  Pages: "N",
  Markdown: "M",
  "Other links": "↗",
};

/** Grouped, searchable shelf. HQ documents go to `onRead`; external links open a tab. */
export function HqShelfList(props: {
  shelf: readonly HqShelfDoc[];
  reading: string | undefined;
  onRead: (target: string) => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    const docs = props.shelf.filter(
      (entry) => !term || `${entry.name} ${entry.by} ${entry.group}`.toLowerCase().includes(term),
    );
    return HQ_SHELF_GROUPS.map((group) => ({
      group,
      docs: docs.filter((entry) => entry.group === group),
    })).filter((section) => section.docs.length > 0);
  }, [query, props.shelf]);
  const pick = (entry: HqShelfDoc) => {
    if (entry.target.startsWith("/hq/")) props.onRead(entry.target);
    else if (entry.target) window.open(entry.target, "_blank", "noopener,noreferrer");
  };

  return (
    <div data-testid="hq-room-shelf">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Shelf <span className="opacity-60">{props.shelf.length}</span>
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
                    entry.target === props.reading && "bg-accent",
                  )}
                  onClick={() => pick(entry)}
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
                      {formatRelativeTimeLabel(entry.ts)}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing on the shelf matches.</p>
      ) : null}
    </div>
  );
}

export function HqDocReader(props: { doc: HqShelfDoc; onClose: () => void; back?: boolean }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="hq-doc-reader">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm">
        {/* Beside the shelf (desktop) it closes with X; alone on a phone, back returns to it. */}
        <button
          type="button"
          aria-label="Back to shelf"
          className={cn("text-muted-foreground hover:text-foreground", !props.back && "md:hidden")}
          onClick={props.onClose}
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <span className="min-w-0 flex-1 truncate font-medium">{props.doc.name}</span>
        <a
          href={props.doc.target}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open in new tab"
          className="text-muted-foreground hover:text-foreground"
        >
          <ExternalLinkIcon className="size-4" />
        </a>
        {props.back ? null : (
          <button
            type="button"
            aria-label="Close document"
            className="hidden text-muted-foreground hover:text-foreground md:block"
            onClick={props.onClose}
          >
            <XIcon className="size-4" />
          </button>
        )}
      </div>
      {/* Same-origin via the /hq proxy: no scripts, so a shelf page can't act as T3. */}
      <iframe
        title={props.doc.name}
        src={props.doc.target}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        className="min-h-0 flex-1 bg-white"
      />
    </div>
  );
}

/** Right-panel surface: the shelf of the room this thread belongs to. */
export function HqShelfPanel(props: { threadId: string | null }) {
  const { rooms, selectedSlug } = useHqRooms();
  const [reading, setReading] = useState<string | undefined>();
  const room =
    rooms.find((candidate) => props.threadId && candidate.threadIds.has(props.threadId)) ??
    rooms.find((candidate) => candidate.slug === selectedSlug) ??
    null;
  const doc = room?.shelf.find((entry) => entry.target === reading) ?? null;

  if (room === null) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {rooms.length === 0 ? "Loading rooms…" : "This thread isn't in an HQ room."}
      </p>
    );
  }
  if (doc) return <HqDocReader doc={doc} onClose={() => setReading(undefined)} back />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="hq-shelf-panel">
      <Link
        to="/rooms/$slug"
        params={{ slug: room.slug }}
        className="mb-3 block text-sm font-medium hover:underline"
      >
        {room.label}
      </Link>
      <HqShelfList shelf={room.shelf} reading={reading} onRead={setReading} />
    </div>
  );
}
