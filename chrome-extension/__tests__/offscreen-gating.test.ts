import browser from "webextension-polyfill";
import { ensureOffscreen, closeOffscreen } from "../message-handler";

// `offscreen` is a Chrome-only MV3 surface the webextension-polyfill `Browser`
// type does not declare, so reach it through `any` — the same cast the
// production call site uses (`(chrome as any).offscreen` in message-handler.ts)
// and the smoke test already establishes.
const offscreen = (browser as any).offscreen;

describe("ensureOffscreen MV3 gating", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (offscreen.hasDocument as jest.Mock).mockResolvedValue(false);
    (offscreen.createDocument as jest.Mock).mockResolvedValue(undefined);
    (offscreen.closeDocument as jest.Mock).mockResolvedValue(undefined);
    (browser.runtime.getURL as jest.Mock).mockReturnValue(
      "chrome-extension://test/offscreen.html"
    );
  });

  it("creates the offscreen document with the BLOBS reason when none exists", async () => {
    await ensureOffscreen();
    expect(offscreen.createDocument).toHaveBeenCalledTimes(1);
    const arg = (offscreen.createDocument as jest.Mock).mock.calls[0][0];
    expect(arg.url).toBe("chrome-extension://test/offscreen.html");
    expect(arg.reasons).toEqual(["BLOBS"]);
    expect(typeof arg.justification).toBe("string");
    expect(arg.justification.length).toBeGreaterThan(0);
  });

  it("does NOT create a second document when hasDocument() reports one already exists", async () => {
    (offscreen.hasDocument as jest.Mock).mockResolvedValue(true);
    await ensureOffscreen();
    expect(offscreen.createDocument).not.toHaveBeenCalled();
  });

  it("closeOffscreen closes the document only when one exists", async () => {
    (offscreen.hasDocument as jest.Mock).mockResolvedValue(true);
    await closeOffscreen();
    expect(offscreen.closeDocument).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    (offscreen.hasDocument as jest.Mock).mockResolvedValue(false);
    await closeOffscreen();
    expect(offscreen.closeDocument).not.toHaveBeenCalled();
  });
});
