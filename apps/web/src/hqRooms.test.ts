import { describe, expect, it, vi } from "vite-plus/test";

// hqRooms reads the selected room from localStorage at import.
vi.hoisted(() => {
  const store = new Map<string, string>();
  globalThis.localStorage ??= {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  } as Storage;
});

import { moveRoomOrder, parseRoomsFeed } from "./hqRooms";

describe("moveRoomOrder", () => {
  const rooms = [
    { slug: "a", zone: "today" },
    { slug: "b", zone: "today" },
    { slug: "c", zone: "permanent" },
  ] as const;

  it("moves a room to the end of its new section and keeps the rest in order", () => {
    expect(moveRoomOrder(rooms, "a", "backlog")).toEqual({
      today: ["b"],
      permanent: ["c"],
      backlog: ["a"],
    });
    expect(moveRoomOrder(rooms, "c", "today")).toEqual({
      today: ["a", "b", "c"],
      permanent: [],
      backlog: [],
    });
  });

  it("inserts a room before another, within or across sections", () => {
    expect(moveRoomOrder(rooms, "b", "today", "a")).toEqual({
      today: ["b", "a"],
      permanent: ["c"],
      backlog: [],
    });
    expect(moveRoomOrder(rooms, "c", "today", "b")).toEqual({
      today: ["a", "c", "b"],
      permanent: [],
      backlog: [],
    });
  });
});

describe("parseRoomsFeed", () => {
  it("serves HQ documents through the /hq proxy and drops links it cannot open", () => {
    const doc = { group: "Markdown", by: "", ts: "" } as const;
    const [room] = parseRoomsFeed([
      {
        slug: "hq",
        label: "HQ",
        zone: "permanent",
        attention: [],
        agents: 1,
        threadIds: ["t1"],
        shelf: [
          { ...doc, name: "reader", link: "/doc/room-document/1" },
          { ...doc, name: "web", link: "https://example.com/a" },
          { ...doc, name: "path", link: "", localPath: "/tmp/a.md" },
        ],
      },
    ]);
    expect(room?.threadIds.has("t1")).toBe(true);
    expect(room?.shelf.map((entry) => entry.target)).toEqual([
      "/hq/doc/room-document/1",
      "https://example.com/a",
      "",
    ]);
  });
});
