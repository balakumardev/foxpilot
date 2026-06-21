/**
 * Bridge batching: the isolated-world bridge must coalesce many console entries
 * into a SINGLE runtime.sendMessage per flush interval, so chatty pages cannot
 * flood the browser IO thread with per-line IPC.
 */
import {
  enqueueConsoleEntry,
  flushConsoleBatch,
  _resetForTest,
} from "../console-capture-bridge";

describe("console-capture bridge batching", () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    _resetForTest();
  });

  afterEach(() => {
    _resetForTest();
    jest.useRealTimers();
  });

  it("coalesces many entries into ONE sendMessage on flush", () => {
    for (let i = 0; i < 50; i++) {
      enqueueConsoleEntry({ level: "log", text: "m" + i });
    }
    // Nothing sent yet — batched on the timer, not per entry.
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();

    flushConsoleBatch();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const msg = (chrome.runtime.sendMessage as jest.Mock).mock.calls[0][0];
    expect(msg.type).toBe("bcmcp-console-batch");
    expect(msg.entries).toHaveLength(50);
    expect(msg.entries[0]).toMatchObject({ level: "log", text: "m0" });
    expect(msg.entries[49]).toMatchObject({ level: "log", text: "m49" });
  });

  it("auto-flushes a buffered entry after the flush interval", () => {
    jest.useFakeTimers();
    enqueueConsoleEntry({ level: "warn", text: "later" });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();

    jest.advanceTimersByTime(250);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const msg = (chrome.runtime.sendMessage as jest.Mock).mock.calls[0][0];
    expect(msg.entries).toHaveLength(1);
    expect(msg.entries[0]).toMatchObject({ level: "warn", text: "later" });
  });

  it("drops the oldest beyond the buffer cap and reports the drop count", () => {
    const CAP = 500;
    for (let i = 0; i < CAP + 10; i++) {
      enqueueConsoleEntry({ level: "log", text: "x" + i });
    }
    flushConsoleBatch();

    const msg = (chrome.runtime.sendMessage as jest.Mock).mock.calls[0][0];
    // CAP retained entries + 1 synthetic "dropped" notice.
    expect(msg.entries).toHaveLength(CAP + 1);
    expect(msg.entries[0].text).toBe("x10"); // x0..x9 dropped
    const notice = msg.entries[msg.entries.length - 1];
    expect(notice.level).toBe("warn");
    expect(notice.text).toContain("dropped 10");
  });

  it("is a no-op when the buffer is empty", () => {
    flushConsoleBatch();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("normalizes a non-string/missing level and text", () => {
    enqueueConsoleEntry({ text: 42 as unknown as string });
    flushConsoleBatch();
    const msg = (chrome.runtime.sendMessage as jest.Mock).mock.calls[0][0];
    expect(msg.entries[0].level).toBe("log");
    expect(msg.entries[0].text).toBe("42");
  });
});
