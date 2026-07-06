jest.mock("../network-capture", () => ({
  attachDebugger: jest.fn(async () => {}),
  detachDebugger: jest.fn(async () => {}),
}));
import { cdpEval } from "../cdp-eval";
import { attachDebugger, detachDebugger } from "../network-capture";

function mockDebugger(sendImpl: (method: string, params: any) => any) {
  (globalThis as any).chrome = {
    debugger: { sendCommand: jest.fn(async (_t: any, method: string, params: any) => sendImpl(method, params)) },
  };
}

test("cdpEval returns the Runtime.evaluate value and attaches/detaches the eval purpose", async () => {
  mockDebugger((method) => {
    if (method === "Runtime.evaluate") return { result: { value: 42 } };
    return {};
  });
  const r = await cdpEval(7, "() => 40 + 2", []);
  expect(r).toEqual({ ok: true, value: 42 });
  expect(attachDebugger).toHaveBeenCalledWith(7, "eval");
  expect(detachDebugger).toHaveBeenCalledWith(7, "eval");
});

test("cdpEval surfaces exceptionDetails as ok:false", async () => {
  mockDebugger((method) => {
    if (method === "Runtime.evaluate") return { exceptionDetails: { exception: { description: "ReferenceError: x is not defined" } } };
    return {};
  });
  const r = await cdpEval(7, "() => x", []);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("ReferenceError");
});

test("cdpEval detaches even when Runtime.evaluate throws", async () => {
  mockDebugger(() => { throw new Error("Target closed"); });
  const r = await cdpEval(7, "() => 1", []);
  expect(r.ok).toBe(false);
  expect(detachDebugger).toHaveBeenCalledWith(7, "eval");
});

test("cdpEval returns a friendly ok:false and does NOT detach when attach fails", async () => {
  mockDebugger(() => ({}));
  // A failed attach means nothing was attached — per the refcount contract,
  // detachDebugger must NOT run. Clear its history so the assertion reflects
  // only this test.
  (detachDebugger as jest.Mock).mockClear();
  (attachDebugger as jest.Mock).mockRejectedValueOnce(
    new Error("Another debugger is already attached to this tab.")
  );
  const r = await cdpEval(7, "() => 1", []);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("attach");
  expect(detachDebugger).not.toHaveBeenCalled();
});
