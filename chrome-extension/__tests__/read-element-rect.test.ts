import "../content-script";

/**
 * The content script's `readElementRect` message backs take-screenshot {uid},
 * the humanized cursor path and the CDP engine's resolveUidCenter. Its uid
 * lookup pierces shadow roots — open, and closed through BOTH extension API
 * shapes the shared helper supports (Chrome's `chrome.dom` function, Firefox's
 * `openOrClosedShadowRoot` property; the helper body is shared across modules).
 * Driven through the real onMessage listener the content script registers.
 */
const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0] as (
  msg: unknown,
  sender: unknown,
  sendResponse: (r: unknown) => void
) => boolean;

function readRect(uid: string): Promise<{ x: number; width: number } | null> {
  return new Promise((resolve) => {
    listener({ type: "readElementRect", uid }, {}, resolve as (r: unknown) => void);
  });
}

describe("content-script readElementRect resolves uids through shadow roots", () => {
  const closedRoots = new Map<Element, ShadowRoot>();
  let restoreClosed: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    if (restoreClosed) {
      restoreClosed();
      restoreClosed = null;
    }
    closedRoots.clear();
    document.body.innerHTML = "";
  });

  function host(tag: string, html: string, mode: "open" | "closed"): ShadowRoot {
    const h = document.createElement(tag);
    document.body.appendChild(h);
    const root = h.attachShadow({ mode });
    root.innerHTML = html;
    if (mode === "closed") {
      closedRoots.set(h, root);
    }
    return root;
  }

  it("still measures a light-DOM uid", async () => {
    document.body.innerHTML = `<button data-bcmcp-uid="e1">Go</button>`;
    const r = await readRect("e1");
    expect(r).not.toBeNull();
    expect(typeof r!.width).toBe("number");
  });

  it("returns null for a missing uid", async () => {
    expect(await readRect("nope")).toBeNull();
  });

  it("measures a uid inside an open shadow root", async () => {
    host("amp-nav", `<button data-bcmcp-uid="e2">Users and Access</button>`, "open");
    expect(await readRect("e2")).not.toBeNull();
  });

  it("measures a uid inside a closed root via chrome.dom.openOrClosedShadowRoot, and not without it", async () => {
    host("amp-secret", `<button data-bcmcp-uid="e3">Closed</button>`, "closed");
    expect(await readRect("e3")).toBeNull();
    (chrome as any).dom = {
      openOrClosedShadowRoot: (el: Element) => closedRoots.get(el) || el.shadowRoot || null,
    };
    restoreClosed = () => {
      delete (chrome as any).dom;
    };
    expect(await readRect("e3")).not.toBeNull();
  });

  it("measures a uid inside a closed root via the Firefox-shape property", async () => {
    host("amp-secret", `<button data-bcmcp-uid="e4">Closed</button>`, "closed");
    Object.defineProperty(Element.prototype, "openOrClosedShadowRoot", {
      configurable: true,
      get(this: Element) {
        return closedRoots.get(this) || this.shadowRoot || null;
      },
    });
    restoreClosed = () => {
      delete (Element.prototype as any).openOrClosedShadowRoot;
    };
    expect(await readRect("e4")).not.toBeNull();
  });
});
