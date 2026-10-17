import { formatTabList } from "../tab-list-format";

const NOW = Date.parse("2026-10-17T10:00:00Z");
const minutesAgo = (n: number) => NOW - n * 60_000;

function texts(items: { type: "text"; text: string }[]): string[] {
  return items.map((i) => i.text);
}

describe("formatTabList", () => {
  const tabs = [
    { id: 1, url: "https://a.com", title: "A", lastAccessed: minutesAgo(3), windowId: 7 },
    { id: 2, url: "https://b.com", title: "B", windowId: 8 },
    { id: 3, url: "https://c.com", title: "C" },
  ];

  it("prints a pagination header followed by one line per tab", () => {
    const out = texts(
      formatTabList(tabs, { offset: 0, limit: 100, filtered: false, now: NOW })
    );
    expect(out[0]).toBe("Showing tabs 1-3 of 3 total tabs");
    expect(out).toHaveLength(4);
  });

  it("keeps the existing line shape and appends the window id when known", () => {
    const out = texts(
      formatTabList(tabs, { offset: 0, limit: 100, filtered: false, now: NOW })
    );
    expect(out[1]).toBe(
      "tab id=1, tab url=https://a.com, tab title=A, last accessed=3 minutes ago, window id=7"
    );
    // no lastAccessed -> "unknown"; no windowId -> no suffix at all
    expect(out[2]).toBe(
      "tab id=2, tab url=https://b.com, tab title=B, last accessed=unknown, window id=8"
    );
    expect(out[3]).toBe(
      "tab id=3, tab url=https://c.com, tab title=C, last accessed=unknown"
    );
  });

  it("treats window id 0 as a real window", () => {
    const out = texts(
      formatTabList([{ id: 9, url: "u", title: "t", windowId: 0 }], {
        offset: 0,
        limit: 10,
        filtered: false,
        now: NOW,
      })
    );
    expect(out[1]).toContain(", window id=0");
  });

  it("paginates and points at the next offset", () => {
    const out = texts(
      formatTabList(tabs, { offset: 1, limit: 1, filtered: false, now: NOW })
    );
    expect(out[0]).toBe(
      "Showing tabs 2-2 of 3 total tabs (use offset=2 to see more)"
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toContain("tab id=2");
  });

  it("clamps the limit to 1..500", () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ id: i, url: "u", title: "t" }));
    expect(
      formatTabList(many, { offset: 0, limit: 9999, filtered: false, now: NOW })
    ).toHaveLength(1 + 500);
    expect(
      formatTabList(many, { offset: 0, limit: 0, filtered: false, now: NOW })
    ).toHaveLength(1 + 1);
  });

  it("says so plainly when there are no tabs", () => {
    expect(
      texts(formatTabList([], { offset: 0, limit: 100, filtered: false, now: NOW }))
    ).toEqual(["No open tabs."]);
  });

  it("says the filters matched nothing when they did", () => {
    const out = texts(
      formatTabList([], { offset: 0, limit: 100, filtered: true, now: NOW })
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/no open tabs match/i);
    expect(out[0]).toMatch(/windowId|activeOnly|visibleOnly/);
  });
});
