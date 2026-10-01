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

import { moveRoomOrder, shelfGroup } from "./hqRooms";

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

describe("shelfGroup", () => {
  it("groups by recorded kind, then by the ref's shape", () => {
    const group = (ref: string, kind = "file") => shelfGroup({ ref, kind });
    expect(group("https://app.graphite.com/github/pr/acme/app/7", "pr")).toBe("Pull requests");
    expect(group("https://github.com/acme/app/pull/7")).toBe("Pull requests");
    expect(group("/w/cc/hq/plan.html", "html")).toBe("Pages");
    expect(group("https://www.notion.so/Plan-1")).toBe("Pages");
    expect(group("/w/cc/hq/NOTES.MD")).toBe("Markdown");
    expect(group("/w/cc/hq/shot.png", "png")).toBe("Other");
  });
});
