import { describe, expect, it } from "vitest";

import { AsyncQueue } from "../../../src/utils/async-queue.js";

describe("AsyncQueue.push", () => {
  it("buffers values in FIFO order", async () => {
    const queue = new AsyncQueue<string>();

    expect(queue.push("first")).toBe(true);
    expect(queue.push("second")).toBe(true);
    expect(queue.length).toBe(2);

    await expect(queue.next()).resolves.toEqual({ value: "first", done: false });
    expect(queue.length).toBe(1);
    await expect(queue.next()).resolves.toEqual({ value: "second", done: false });
    expect(queue.length).toBe(0);
  });

  it("delivers a pushed value directly to a waiting consumer", async () => {
    const queue = new AsyncQueue<number>();
    const pending = queue.next();

    expect(queue.push(42)).toBe(true);
    await expect(pending).resolves.toEqual({ value: 42, done: false });
    expect(queue.length).toBe(0);
  });

  it("preserves undefined when it is a valid queue value", async () => {
    const queue = new AsyncQueue<string | undefined>();

    expect(queue.push(undefined)).toBe(true);
    queue.end();

    await expect(queue.next()).resolves.toEqual({ value: undefined, done: false });
    await expect(queue.next()).resolves.toEqual({ value: undefined, done: true });
  });
});

describe("AsyncQueue.end", () => {
  it("drains buffered values before reporting completion", async () => {
    const queue = new AsyncQueue<string>();
    queue.push("buffered");

    queue.end();

    expect(queue.closed).toBe(true);
    expect(queue.push("late")).toBe(false);
    await expect(queue.next()).resolves.toEqual({ value: "buffered", done: false });
    await expect(queue.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("completes every pending consumer and is idempotent", async () => {
    const queue = new AsyncQueue<number>();
    const first = queue.next();
    const second = queue.next();

    queue.end();
    queue.end();

    await expect(first).resolves.toEqual({ value: undefined, done: true });
    await expect(second).resolves.toEqual({ value: undefined, done: true });
  });
});

describe("AsyncQueue.fail", () => {
  it("rejects pending and future consumers with the original failure", async () => {
    const queue = new AsyncQueue<number>();
    const failure = new Error("transport closed");
    const pending = queue.next();

    queue.fail(failure);

    expect(queue.closed).toBe(true);
    expect(queue.push(7)).toBe(false);
    await expect(pending).rejects.toBe(failure);
    await expect(queue.next()).rejects.toBe(failure);
  });

  it("drains buffered values before surfacing the failure", async () => {
    const queue = new AsyncQueue<string>();
    const failure = new Error("failed after read");
    queue.push("already received");

    queue.fail(failure);
    queue.fail(new Error("ignored second failure"));

    await expect(queue.next()).resolves.toEqual({ value: "already received", done: false });
    await expect(queue.next()).rejects.toBe(failure);
  });
});

describe("AsyncQueue async iteration", () => {
  it("returns itself as its async iterator", () => {
    const queue = new AsyncQueue<number>();

    expect(queue[Symbol.asyncIterator]()).toBe(queue);
  });
});
