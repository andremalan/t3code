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

import { moveRoomOrder } from "./hqRooms";

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
});
