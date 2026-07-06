import { raceInputAgainstNavigation } from "../nav-race";

function mockTabs() {
  const listeners: any[] = [];
  (globalThis as any).chrome = {
    tabs: {
      onUpdated: {
        addListener: (cb: any) => listeners.push(cb),
        removeListener: (cb: any) => {
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
  };
  return {
    fireNav: (tabId: number) =>
      listeners.forEach((cb) => cb(tabId, { status: "loading" }, {})),
    count: () => listeners.length,
  };
}

test("returns the dispatch result when no navigation occurs", async () => {
  mockTabs();
  const r = await raceInputAgainstNavigation(5, Promise.resolve({ ok: true }));
  expect(r).toEqual({ ok: true });
});

test("returns navigated:true when the tab starts loading before the ack", async () => {
  const t = mockTabs();
  let resolveDispatch: (v: any) => void;
  const dispatch = new Promise<any>((res) => {
    resolveDispatch = res;
  });
  const p = raceInputAgainstNavigation(5, dispatch);
  t.fireNav(5); // nav wins
  const r = await p;
  expect(r).toEqual({ ok: true, navigated: true });
  expect(t.count()).toBe(0); // listener removed
});

test("ignores navigation on a different tab", async () => {
  const t = mockTabs();
  const dispatch = Promise.resolve({ ok: true, foo: 1 });
  const p = raceInputAgainstNavigation(5, dispatch);
  t.fireNav(999); // different tab — must not win
  const r = await p;
  expect(r).toMatchObject({ ok: true, foo: 1 });
});
