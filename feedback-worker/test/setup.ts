import { afterEach, beforeEach, expect, vi } from "vitest";

// The suite must never reach the network. Tests inject a fake fetch; one that forgets to
// gets this blocked global instead, and fails.
const blocked: string[] = [];

beforeEach(() => {
  blocked.length = 0;
  vi.stubGlobal("fetch", async (input: unknown) => {
    blocked.push(String(input));
    throw new Error("network access is blocked in tests");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(blocked, "the test called the global fetch").toEqual([]);
});
