import { readElementRect } from "../message-handler";

/**
 * readElementRect is stringified into the page for take-screenshot {uid} and the
 * humanized (synthetic) cursor path, so it is exercised here the way it ships:
 * its .toString() source evaluated in the page's global scope, which also proves
 * it stays self-contained. The uid lookup pierces shadow roots — open, and
 * closed through BOTH extension API shapes the shared helper supports (Firefox's
 * `openOrClosedShadowRoot` property, Chrome's `chrome.dom` function).
 */
describe("readElementRect (stringified) resolves uids through shadow roots", () => {
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

  function runInPage(uid: string): { x: number; y: number; width: number; height: number; dpr: number } | null {
    return (0, eval)("(" + readElementRect.toString() + ")(document, " + JSON.stringify(uid) + ")");
  }
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

  it("still measures a light-DOM uid (and scrolls it into view)", () => {
    document.body.innerHTML = `<button data-bcmcp-uid="e1">Go</button>`;
    const btn = document.querySelector("button")!;
    (btn as any).scrollIntoView = jest.fn();
    const r = runInPage("e1");
    expect(r).not.toBeNull();
    expect(typeof r!.width).toBe("number");
    expect((btn as any).scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "center" });
  });

  it("returns null for a missing uid", () => {
    expect(runInPage("nope")).toBeNull();
  });

  it("measures a uid inside an open shadow root", () => {
    const root = host("amp-nav", `<button data-bcmcp-uid="e2">Users and Access</button>`, "open");
    const btn = root.querySelector("button")!;
    (btn as any).scrollIntoView = jest.fn();
    expect(runInPage("e2")).not.toBeNull();
    expect((btn as any).scrollIntoView).toHaveBeenCalled();
  });

  it("measures a uid inside a closed root via the Firefox property, and not without it", () => {
    host("amp-secret", `<button data-bcmcp-uid="e3">Closed</button>`, "closed");
    expect(runInPage("e3")).toBeNull();
    Object.defineProperty(Element.prototype, "openOrClosedShadowRoot", {
      configurable: true,
      get(this: Element) {
        return closedRoots.get(this) || this.shadowRoot || null;
      },
    });
    restoreClosed = () => {
      delete (Element.prototype as any).openOrClosedShadowRoot;
    };
    expect(runInPage("e3")).not.toBeNull();
  });

  it("measures a uid inside a closed root via chrome.dom.openOrClosedShadowRoot", () => {
    host("amp-secret", `<button data-bcmcp-uid="e4">Closed</button>`, "closed");
    const g = globalThis as any;
    g.chrome = {
      dom: { openOrClosedShadowRoot: (el: Element) => closedRoots.get(el) || el.shadowRoot || null },
    };
    restoreClosed = () => {
      delete g.chrome;
    };
    expect(runInPage("e4")).not.toBeNull();
  });
});
