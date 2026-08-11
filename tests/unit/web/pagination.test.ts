import { describe, expect, it } from "vitest";

import { collectCursorPages } from "../../../web/pagination.js";

describe("collectCursorPages", () => {
  it("loads every page in cursor order", async () => {
    const requested: Array<number | undefined> = [];
    const items = await collectCursorPages(async (cursor) => {
      requested.push(cursor);
      if (cursor === undefined) return { items: ["one"], nextCursor: 4 };
      if (cursor === 4) return { items: ["two"], nextCursor: 9 };
      return { items: ["three"] };
    });

    expect(requested).toEqual([undefined, 4, 9]);
    expect(items).toEqual(["one", "two", "three"]);
  });

  it("rejects invalid and repeated cursors", async () => {
    await expect(
      collectCursorPages(async () => ({ items: [], nextCursor: -1 }))
    ).rejects.toThrow(/non-negative safe integer/u);

    await expect(
      collectCursorPages(async () => ({ items: [], nextCursor: 1 }))
    ).rejects.toThrow(/cursor repeated: 1/u);
  });

  it("bounds a server that never ends pagination", async () => {
    let next = 0;
    await expect(
      collectCursorPages(async () => ({ items: [], nextCursor: next++ }), 2)
    ).rejects.toThrow(/exceeded 2 pages/u);
  });
});
