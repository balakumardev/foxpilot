import {
  dispatchMouseMoveStep,
  typeCharStep,
  readElementScreenRect,
} from "../injected/humanize-steps";

// Chrome mirror: the humanize injected steps are byte-identical to Firefox.
// Covers the A1 key-identity + A5 contenteditable fixes.

describe("humanize typeCharStep — key identity + contenteditable (A1/A5)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("carries code/keyCode/which and emits keydown→keypress→keyup for a printable char", () => {
    document.body.innerHTML = `<input type="text" />`;
    const input = document.querySelector("input")!;
    input.focus();
    const seq: string[] = [];
    let kd: KeyboardEvent | null = null;
    input.addEventListener("keydown", (e) => {
      seq.push("keydown");
      kd = e as KeyboardEvent;
    });
    input.addEventListener("keypress", () => seq.push("keypress"));
    input.addEventListener("keyup", () => seq.push("keyup"));

    const res = typeCharStep(document, "b");

    expect(res.ok).toBe(true);
    expect(seq).toEqual(["keydown", "keypress", "keyup"]);
    expect(kd!.code).toBe("KeyB");
    expect(kd!.keyCode).toBe(66);
    expect(kd!.which).toBe(66);
  });

  it("types one char into a focused contenteditable via beforeinput/input (insertText)", () => {
    document.body.innerHTML = `<div contenteditable="true"></div>`;
    const ce = document.querySelector("[contenteditable]") as HTMLElement;
    ce.focus();
    const bi: Array<{ inputType?: string; data?: string }> = [];
    ce.addEventListener("beforeinput", (e) =>
      bi.push(e as unknown as { inputType?: string; data?: string })
    );

    const res = typeCharStep(document, "x");

    expect(res.ok).toBe(true);
    expect(ce.textContent).toBe("x");
    expect(bi.length).toBe(1);
    expect(bi[0].inputType).toBe("insertText");
    expect(bi[0].data).toBe("x");
  });
});

/**
 * Humanized (synthetic) steps through shadow roots: the cursor-move hit-test,
 * the per-char typing target and the screen-rect uid lookup all pierce shadow
 * roots (open, and closed via both extension API shapes). Identical block in
 * the Firefox and Chrome suites.
 */
describe("humanize steps pierce shadow roots", () => {
  const closedRoots = new Map<Element, ShadowRoot>();
  let restoreClosed: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    delete (document as any).elementFromPoint;
    if (restoreClosed) {
      restoreClosed();
      restoreClosed = null;
    }
    closedRoots.clear();
    document.body.innerHTML = "";
  });

  function openHost(tag: string, html: string): ShadowRoot {
    const host = document.createElement(tag);
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = html;
    return root;
  }
  function closedHost(tag: string, html: string): ShadowRoot {
    const host = document.createElement(tag);
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = html;
    closedRoots.set(host, root);
    return root;
  }
  function exposeClosedViaProperty(): void {
    Object.defineProperty(Element.prototype, "openOrClosedShadowRoot", {
      configurable: true,
      get(this: Element) {
        return closedRoots.get(this) || this.shadowRoot || null;
      },
    });
    restoreClosed = () => {
      delete (Element.prototype as any).openOrClosedShadowRoot;
    };
  }
  function exposeClosedViaChromeDom(): void {
    const g = globalThis as any;
    const hadChrome = typeof g.chrome !== "undefined";
    if (!hadChrome) {
      g.chrome = {};
    }
    g.chrome.dom = {
      openOrClosedShadowRoot: (el: Element) => closedRoots.get(el) || el.shadowRoot || null,
    };
    restoreClosed = () => {
      delete g.chrome.dom;
      if (!hadChrome) {
        delete g.chrome;
      }
    };
  }

  it("dispatchMouseMoveStep moves over the element inside the shadow root, not its host", () => {
    const root = openHost("amp-nav", `<button id="ua">Users and Access</button>`);
    const btn = root.getElementById("ua")!;
    (document as any).elementFromPoint = () => root.host;
    (root as any).elementFromPoint = () => btn;
    const seen: EventTarget[] = [];
    btn.addEventListener("mousemove", (e) => seen.push(e.target as EventTarget));

    const res = dispatchMouseMoveStep(document, 12, 34);

    expect(res.ok).toBe(true);
    expect(seen).toEqual([btn]);
  });

  it("typeCharStep appends to an input focused inside an open shadow root", () => {
    const root = openHost("amp-search", `<input id="q" value="io" />`);
    const q = root.getElementById("q") as HTMLInputElement;
    q.focus();

    const res = typeCharStep(document, "s");

    expect(res.ok).toBe(true);
    expect(q.value).toBe("ios");
  });

  it("typeCharStep reaches an input focused inside a CLOSED root (Firefox property, then chrome.dom)", () => {
    const root = closedHost("amp-search", `<input id="q" />`);
    const q = root.getElementById("q") as HTMLInputElement;
    q.focus();

    expect(typeCharStep(document, "x").ok).toBe(false); // page world: the host is all it sees
    exposeClosedViaProperty();
    expect(typeCharStep(document, "t").ok).toBe(true);
    restoreClosed!();
    exposeClosedViaChromeDom();
    expect(typeCharStep(document, "v").ok).toBe(true);
    expect(q.value).toBe("tv");
  });

  it("readElementScreenRect resolves a uid inside a shadow root", () => {
    openHost("amp-nav", `<button data-bcmcp-uid="e1">Users and Access</button>`);
    const r = readElementScreenRect(document, "e1");
    expect(r).not.toBeNull();
    expect(typeof r!.screenX).toBe("number");
  });
});

/**
 * Review fix for the humanized steps: the screen-rect uid lookup tries open
 * shadow roots before probing closed ones, and the fallback input event (no
 * InputEvent constructor) is composed like the InputEvent one. Identical block
 * in the Firefox and Chrome suites.
 */
describe("humanize steps: lookup cost and composed fallback input", () => {
  const probe = { calls: 0 };
  let hadChrome = false;

  beforeEach(() => {
    document.body.innerHTML = "";
    probe.calls = 0;
    const g = globalThis as any;
    hadChrome = typeof g.chrome !== "undefined";
    if (!hadChrome) {
      g.chrome = {};
    }
    g.chrome.dom = {
      openOrClosedShadowRoot: () => {
        probe.calls++;
        return null;
      },
    };
  });
  afterEach(() => {
    const g = globalThis as any;
    delete g.chrome.dom;
    if (!hadChrome) {
      delete g.chrome;
    }
    jest.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("readElementScreenRect resolves an open-root uid without a closed-root probe", () => {
    document.body.innerHTML = `<div><span>a</span><span>b</span></div>`;
    const host = document.createElement("x-nav");
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" }).innerHTML = `<div><button data-bcmcp-uid="e1">Users</button></div>`;

    expect(readElementScreenRect(document, "e1")).not.toBeNull();
    expect(probe.calls).toBe(0);
  });

  it("typeCharStep's fallback input event (no InputEvent) is composed, so a host listener sees it", () => {
    const host = document.createElement("x-field");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<input id="q" />`;
    (root.getElementById("q") as HTMLInputElement).focus();
    const seen: string[] = [];
    host.addEventListener("input", () => seen.push("input"));
    const saved = (window as any).InputEvent;
    (window as any).InputEvent = undefined;
    try {
      expect(typeCharStep(document, "x").ok).toBe(true);
    } finally {
      (window as any).InputEvent = saved;
    }

    expect((root.getElementById("q") as HTMLInputElement).value).toBe("x");
    expect(seen).toEqual(["input"]);
  });
});
