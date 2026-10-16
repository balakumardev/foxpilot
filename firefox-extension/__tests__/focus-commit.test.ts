import { performInputAction } from "../injected/action-script";
import { performPointAction } from "../injected/point-action-script";
import { selectOption } from "../injected/select-option-script";

/**
 * PER-12: fields that take their value on blur, in a document without system
 * focus (a background tab, or a browser window behind another app). There the
 * browser still moves activeElement on focus() and blur(), but fires no focus,
 * blur, focusin or focusout, so Google Play Console's invite email (an
 * AngularDart material-input[blurupdate]) never committed and "Invite user"
 * stayed disabled.
 *
 * jsdom fires those events (trusted), so `unfocused()` stops the trusted ones
 * at the window before any other listener sees them, the way the blur-commit
 * fixture's ?unfocused=1 mode does. Events FoxPilot dispatches itself are
 * untrusted and pass. The real-browser proof is e2e/blur-commit.spec.ts.
 */
const FOCUS_TYPES = ["focus", "blur", "focusin", "focusout"];
let restoreFocusEvents: (() => void) | null = null;

function unfocused(): void {
  const stop = (e: Event) => {
    if (e.isTrusted) {
      e.stopImmediatePropagation();
    }
  };
  FOCUS_TYPES.forEach((t) => window.addEventListener(t, stop, true));
  restoreFocusEvents = () => FOCUS_TYPES.forEach((t) => window.removeEventListener(t, stop, true));
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function stamp(el: Element, uid: string): void {
  el.setAttribute("data-bcmcp-uid", uid);
}

// "type:target:relatedTarget:t|u" for every focus event the elements get.
function recordFocus(els: Element[], log: string[]): void {
  for (const el of els) {
    FOCUS_TYPES.forEach((t) =>
      el.addEventListener(t, (e) => {
        const rel = (e as FocusEvent).relatedTarget as Element | null;
        log.push(`${t}:${el.id}:${rel ? rel.id || rel.localName : "null"}:${e.isTrusted ? "t" : "u"}`);
      })
    );
  }
}

// AngularDart's material-input[blurupdate] in miniature: input events update
// the component's text, and the form model takes that text on the input's own
// blur. Nothing else commits it.
function blurUpdate(input: HTMLInputElement): { committed: string | null } {
  const model = { committed: null as string | null };
  let text = "";
  input.addEventListener("input", () => {
    text = input.value;
  });
  input.addEventListener("blur", () => {
    model.committed = text;
  });
  return model;
}

afterEach(() => {
  if (restoreFocusEvents) {
    restoreFocusEvents();
  }
  restoreFocusEvents = null;
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.body.innerHTML = "";
  (document as any).elementFromPoint = undefined;
});

describe("the premise", () => {
  it("with trusted focus events stopped, focus() and blur() move activeElement and nothing sees an event", () => {
    unfocused();
    document.body.innerHTML = `<input id="a" />`;
    const a = byId<HTMLInputElement>("a");
    const log: string[] = [];
    recordFocus([a], log);

    a.focus();
    expect(document.activeElement).toBe(a);
    a.blur();
    expect(document.activeElement).toBe(document.body);
    expect(log).toEqual([]);
  });
});

describe("click and fill move focus with the events a focused document fires", () => {
  beforeEach(() => {
    document.body.innerHTML = `<input id="email" type="email" /><button id="add">Add app</button>`;
    stamp(byId("email"), "e1");
    stamp(byId("add"), "e2");
  });

  it("unfocused: a filled blur-update field commits when the next click moves focus off it", () => {
    unfocused();
    const model = blurUpdate(byId<HTMLInputElement>("email"));

    expect(performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co" }).ok).toBe(true);
    // fill does not leave the field by itself.
    expect(model.committed).toBeNull();
    expect(document.activeElement).toBe(byId("email"));

    expect(performInputAction(document, { action: "click", uid: "e2" }).ok).toBe(true);
    expect(model.committed).toBe("a@b.co");
    expect(document.activeElement).toBe(byId("add"));
  });

  it("unfocused: fires blur and focusout on the field left, focus and focusin on the one entered, each naming the other", () => {
    unfocused();
    const log: string[] = [];
    recordFocus([byId("email"), byId("add")], log);

    performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co" });
    expect(log).toEqual(["focus:email:null:u", "focusin:email:null:u"]);

    log.length = 0;
    performInputAction(document, { action: "click", uid: "e2" });
    expect(log).toEqual([
      "blur:email:add:u",
      "focusout:email:add:u",
      "focus:add:email:u",
      "focusin:add:email:u",
    ]);
  });

  it("focused: the browser's own events are the only ones, so nothing is fired twice", () => {
    const model = blurUpdate(byId<HTMLInputElement>("email"));
    const log: string[] = [];
    recordFocus([byId("email"), byId("add")], log);

    performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co" });
    performInputAction(document, { action: "click", uid: "e2" });

    expect(model.committed).toBe("a@b.co");
    expect(log.filter((e) => e.endsWith(":u"))).toEqual([]);
    expect(log.filter((e) => e.startsWith("blur:email"))).toHaveLength(1);
  });

  it("unfocused: a fill that moves focus to another field gives the first its blur", () => {
    document.body.innerHTML = `<input id="email" /><input id="name" />`;
    stamp(byId("email"), "e1");
    stamp(byId("name"), "e2");
    unfocused();
    const model = blurUpdate(byId<HTMLInputElement>("email"));

    performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co" });
    performInputAction(document, { action: "fill", uid: "e2", value: "Ada" });

    expect(model.committed).toBe("a@b.co");
    expect(document.activeElement).toBe(byId("name"));
  });

  it("unfocused: a click handler that moves focus (a dialog focusing its first control) fires those events too", () => {
    document.body.innerHTML = `<button id="open">Add app</button><div id="dialog" hidden><input id="first" type="checkbox" /></div>`;
    stamp(byId("open"), "e1");
    byId("open").addEventListener("click", () => {
      byId("dialog").hidden = false;
      byId("first").focus();
    });
    unfocused();
    const log: string[] = [];
    recordFocus([byId("open"), byId("first")], log);

    performInputAction(document, { action: "click", uid: "e1" });

    expect(document.activeElement).toBe(byId("first"));
    expect(log).toEqual([
      "focus:open:null:u",
      "focusin:open:null:u",
      "blur:open:first:u",
      "focusout:open:first:u",
      "focus:first:open:u",
      "focusin:first:open:u",
    ]);
  });

  it("unfocused: a field inside an open shadow root gets its blur, and the host sees it retargeted", () => {
    document.body.innerHTML = `<x-field id="host"></x-field><button id="add">Add app</button>`;
    const root = byId("host").attachShadow({ mode: "open" });
    root.innerHTML = `<input id="inner" />`;
    const inner = root.getElementById("inner") as HTMLInputElement;
    stamp(inner, "e1");
    stamp(byId("add"), "e2");
    unfocused();
    const model = blurUpdate(inner);
    const hostSaw: string[] = [];
    byId("host").addEventListener("focusout", (e) => hostSaw.push((e.target as Element).id));

    performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co" });
    performInputAction(document, { action: "click", uid: "e2" });

    expect(model.committed).toBe("a@b.co");
    expect(hostSaw).toEqual(["host"]);
  });
});

describe("a click moves focus the way a real press does", () => {
  for (const mode of ["focused", "unfocused"] as const) {
    describe(mode, () => {
      beforeEach(() => {
        if (mode === "unfocused") {
          unfocused();
        }
      });

      it("a click on text that cannot take focus takes focus off the field", () => {
        document.body.innerHTML = `<input id="email" /><p id="note">Users get an email.</p>`;
        stamp(byId("email"), "e1");
        stamp(byId("note"), "e2");
        const model = blurUpdate(byId<HTMLInputElement>("email"));

        performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co" });
        expect(performInputAction(document, { action: "click", uid: "e2" }).ok).toBe(true);

        expect(model.committed).toBe("a@b.co");
        expect(document.activeElement).toBe(document.body);
      });

      it("a press on a child that cannot take focus focuses its nearest focusable ancestor", () => {
        document.body.innerHTML = `<input id="email" /><div id="card" tabindex="-1"><span id="title">Card</span></div>`;
        stamp(byId("email"), "e1");
        stamp(byId("title"), "e2");
        const model = blurUpdate(byId<HTMLInputElement>("email"));

        performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co" });
        performInputAction(document, { action: "click", uid: "e2" });

        expect(model.committed).toBe("a@b.co");
        expect(document.activeElement).toBe(byId("card"));
      });

      it("a click whose mousedown the page cancels (a suggestion keeping focus in its input) leaves focus where it is", () => {
        document.body.innerHTML = `<input id="city" /><ul><li id="opt" role="option">New York</li></ul>`;
        stamp(byId("city"), "e1");
        stamp(byId("opt"), "e2");
        byId("opt").addEventListener("mousedown", (e) => e.preventDefault());
        const blurs: string[] = [];
        byId("city").addEventListener("blur", (e) => blurs.push(e.isTrusted ? "t" : "u"));
        const picked = jest.fn();
        byId("opt").addEventListener("click", picked);

        performInputAction(document, { action: "fill", uid: "e1", value: "New" });
        performInputAction(document, { action: "click", uid: "e2" });

        expect(picked).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(byId("city"));
        expect(blurs).toEqual([]);
      });

      it("a press inside the focused element leaves focus where it is", () => {
        document.body.innerHTML = `<div id="list" role="listbox" tabindex="0"><span id="item">One</span></div>`;
        stamp(byId("list"), "e1");
        stamp(byId("item"), "e2");
        performInputAction(document, { action: "click", uid: "e1" });
        expect(document.activeElement).toBe(byId("list"));
        const blurs = jest.fn();
        byId("list").addEventListener("blur", blurs);

        performInputAction(document, { action: "click", uid: "e2" });

        expect(document.activeElement).toBe(byId("list"));
        expect(blurs).not.toHaveBeenCalled();
      });

      it("a disabled button: the click activates nothing and says so, and still takes focus off the field", () => {
        document.body.innerHTML = `<input id="email" /><button id="invite" disabled>Invite user</button>`;
        stamp(byId("email"), "e1");
        stamp(byId("invite"), "e2");
        const model = blurUpdate(byId<HTMLInputElement>("email"));
        const invited = jest.fn();
        byId("invite").addEventListener("click", invited);

        performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co" });
        const res = performInputAction(document, { action: "click", uid: "e2" });

        expect(res).toEqual({ ok: true, disabled: true });
        expect(invited).not.toHaveBeenCalled();
        expect(model.committed).toBe("a@b.co");
        expect(document.activeElement).toBe(document.body);
      });
    });
  }

  it("a button inside a disabled fieldset is reported disabled; an aria-disabled one is not (the page decides)", () => {
    document.body.innerHTML = `<fieldset disabled><button id="a">A</button></fieldset><div id="b" role="button" tabindex="0" aria-disabled="true">B</div>`;
    stamp(byId("a"), "e1");
    stamp(byId("b"), "e2");
    const bClicked = jest.fn();
    byId("b").addEventListener("click", bClicked);

    expect(performInputAction(document, { action: "click", uid: "e1" })).toEqual({ ok: true, disabled: true });
    expect(performInputAction(document, { action: "click", uid: "e2" })).toEqual({ ok: true });
    expect(bClicked).toHaveBeenCalledTimes(1);
  });

  it("an enabled click reports no disabled field at all (the reply shape is unchanged)", () => {
    document.body.innerHTML = `<button id="go">Go</button>`;
    stamp(byId("go"), "e1");
    expect(performInputAction(document, { action: "click", uid: "e1" })).toEqual({ ok: true });
  });

  it("classify-intercept (the CDP engine's probe) reports a disabled control", () => {
    document.body.innerHTML = `<button id="invite" disabled>Invite user</button><button id="go">Go</button>`;
    stamp(byId("invite"), "e1");
    stamp(byId("go"), "e2");
    expect(performInputAction(document, { action: "classify-intercept", uid: "e1" })).toEqual({
      ok: true,
      disabled: true,
    });
    expect(performInputAction(document, { action: "classify-intercept", uid: "e2" })).toEqual({ ok: true });
  });
});

describe("commit leaves the field once its value is in", () => {
  // The order of everything the field sees, focus events with their trust.
  function recordAll(el: Element, log: string[]): void {
    ["focus", "focusin", "input", "change", "keydown", "blur", "focusout"].forEach((t) =>
      el.addEventListener(t, (e) => {
        const key = t === "keydown" ? ":" + (e as KeyboardEvent).key : "";
        log.push(t + key + (FOCUS_TYPES.indexOf(t) >= 0 ? (e.isTrusted ? ":t" : ":u") : ""));
      })
    );
  }

  it("unfocused fill with commit:true: focus, input, change, then blur and focusout; focus ends on the body", () => {
    document.body.innerHTML = `<input id="email" />`;
    stamp(byId("email"), "e1");
    unfocused();
    const model = blurUpdate(byId<HTMLInputElement>("email"));
    const log: string[] = [];
    recordAll(byId("email"), log);

    const res = performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co", commit: true });

    expect(res).toEqual({ ok: true });
    expect(log).toEqual(["focus:u", "focusin:u", "input", "change", "blur:u", "focusout:u"]);
    expect(model.committed).toBe("a@b.co");
    expect(document.activeElement).toBe(document.body);
  });

  it("focused fill with commit:true leaves the field through the browser's own blur, not a second one", () => {
    document.body.innerHTML = `<input id="email" />`;
    stamp(byId("email"), "e1");
    const log: string[] = [];
    recordAll(byId("email"), log);

    performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co", commit: true });

    expect(log.filter((e) => e.endsWith(":u"))).toEqual([]);
    expect(log.filter((e) => e.startsWith("blur"))).toEqual(["blur:t"]);
    expect(document.activeElement).toBe(document.body);
  });

  it("type-text with commit:true fires change (typing never does) before blur", () => {
    document.body.innerHTML = `<input id="email" />`;
    stamp(byId("email"), "e1");
    unfocused();
    const model = blurUpdate(byId<HTMLInputElement>("email"));
    performInputAction(document, { action: "click", uid: "e1" });
    const log: string[] = [];
    recordAll(byId("email"), log);

    performInputAction(document, { action: "type", text: "ab", commit: true });

    expect(log).toEqual(["input", "keydown:a", "keydown:b", "change", "blur:u", "focusout:u"]);
    expect(model.committed).toBe("ab");
  });

  it("type-text with submit and commit presses Enter in the field first, then leaves it", () => {
    document.body.innerHTML = `<input id="q" />`;
    stamp(byId("q"), "e1");
    unfocused();
    performInputAction(document, { action: "click", uid: "e1" });
    const log: string[] = [];
    recordAll(byId("q"), log);

    performInputAction(document, { action: "type", text: "x", submit: true, commit: true });

    expect(log.indexOf("keydown:Enter")).toBeGreaterThan(-1);
    expect(log.indexOf("keydown:Enter")).toBeLessThan(log.indexOf("blur:u"));
  });

  it("type-text without commit leaves the field focused, as before", () => {
    document.body.innerHTML = `<input id="q" />`;
    stamp(byId("q"), "e1");
    performInputAction(document, { action: "click", uid: "e1" });
    performInputAction(document, { action: "type", text: "x" });
    expect(document.activeElement).toBe(byId("q"));
  });

  it("type into a contenteditable with commit:true blurs the editing host once the editor kept the text", async () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true">hi</div>`;
    const ed = byId("ed");
    ed.focus();
    window.getSelection()!.collapse(ed.firstChild!, 2);
    unfocused();
    const blurs: string[] = [];
    ed.addEventListener("blur", (e) => blurs.push(e.isTrusted ? "t" : "u"));

    const res = await performInputAction(document, { action: "type", text: "!", commit: true });

    expect(res).toEqual({ ok: true });
    expect(ed.textContent).toBe("hi!");
    expect(blurs).toEqual(["u"]);
    expect(document.activeElement).toBe(document.body);
  });

  it("fill-form with commit:true leaves every field, the last one too", () => {
    document.body.innerHTML = `<input id="email" /><input id="name" />`;
    stamp(byId("email"), "e1");
    stamp(byId("name"), "e2");
    unfocused();
    const email = blurUpdate(byId<HTMLInputElement>("email"));
    const name = blurUpdate(byId<HTMLInputElement>("name"));

    const res = performInputAction(document, {
      action: "fill-form",
      fields: [
        { uid: "e1", value: "a@b.co" },
        { uid: "e2", value: "Ada" },
      ],
      commit: true,
    });

    expect(res).toEqual({ ok: true });
    expect(email.committed).toBe("a@b.co");
    expect(name.committed).toBe("Ada");
    expect(document.activeElement).toBe(document.body);
  });

  it("fill-form without commit leaves the last field focused (the others were left as focus moved on)", () => {
    document.body.innerHTML = `<input id="email" /><input id="name" />`;
    stamp(byId("email"), "e1");
    stamp(byId("name"), "e2");
    unfocused();
    const email = blurUpdate(byId<HTMLInputElement>("email"));
    const name = blurUpdate(byId<HTMLInputElement>("name"));

    performInputAction(document, {
      action: "fill-form",
      fields: [
        { uid: "e1", value: "a@b.co" },
        { uid: "e2", value: "Ada" },
      ],
    });

    expect(email.committed).toBe("a@b.co");
    expect(name.committed).toBeNull();
    expect(document.activeElement).toBe(byId("name"));
  });

  it("fill with commit:true on a checkbox leaves it after the click that set it", () => {
    document.body.innerHTML = `<input id="agree" type="checkbox" />`;
    stamp(byId("agree"), "e1");
    unfocused();
    const blurs = jest.fn();
    byId("agree").addEventListener("blur", blurs);

    performInputAction(document, { action: "fill", uid: "e1", value: "true", commit: true });

    expect(byId<HTMLInputElement>("agree").checked).toBe(true);
    expect(blurs).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
  });

  it('the "commit" action leaves the focused field, and fires change only when asked', () => {
    document.body.innerHTML = `<input id="email" />`;
    stamp(byId("email"), "e1");
    unfocused();
    const changes = jest.fn();
    byId("email").addEventListener("change", changes);
    const blurs = jest.fn();
    byId("email").addEventListener("blur", blurs);

    performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co" });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(performInputAction(document, { action: "commit" })).toEqual({ ok: true });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(blurs).toHaveBeenCalledTimes(1);

    performInputAction(document, { action: "fill", uid: "e1", value: "c@d.co" });
    performInputAction(document, { action: "commit", change: true });
    expect(changes).toHaveBeenCalledTimes(3);
    expect(blurs).toHaveBeenCalledTimes(2);
  });

  it('the "commit" action with nothing focused is a no-op', () => {
    document.body.innerHTML = `<input id="email" />`;
    expect(performInputAction(document, { action: "commit", change: true })).toEqual({ ok: true });
    expect(document.activeElement).toBe(document.body);
  });
});

describe("the coordinate tools move focus the same way", () => {
  function stubPoint(el: Element | null): void {
    (document as any).elementFromPoint = jest.fn(() => el);
  }

  it("unfocused click-at on plain text takes focus off the field", () => {
    document.body.innerHTML = `<input id="email" /><p id="note">Users get an email.</p>`;
    stamp(byId("email"), "e1");
    unfocused();
    const model = blurUpdate(byId<HTMLInputElement>("email"));
    performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co" });
    stubPoint(byId("note"));

    const res = performPointAction(document, { action: "click-at", x: 10, y: 10 });

    expect(res.ok).toBe(true);
    expect(model.committed).toBe("a@b.co");
    expect(document.activeElement).toBe(document.body);
  });

  it("unfocused click-at on a field gives the field left its blur and the new one its focus", () => {
    document.body.innerHTML = `<input id="email" /><input id="name" />`;
    stamp(byId("email"), "e1");
    unfocused();
    const model = blurUpdate(byId<HTMLInputElement>("email"));
    performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co" });
    const focuses: string[] = [];
    byId("name").addEventListener("focus", (e) => focuses.push(e.isTrusted ? "t" : "u"));
    stubPoint(byId("name"));

    performPointAction(document, { action: "click-at", x: 10, y: 10 });

    expect(model.committed).toBe("a@b.co");
    expect(focuses).toEqual(["u"]);
    expect(document.activeElement).toBe(byId("name"));
  });

  it("unfocused type-at with commit:true types, fires change and leaves the field", async () => {
    document.body.innerHTML = `<input id="email" />`;
    unfocused();
    const model = blurUpdate(byId<HTMLInputElement>("email"));
    const changes = jest.fn();
    byId("email").addEventListener("change", changes);
    stubPoint(byId("email"));

    const res = await performPointAction(document, {
      action: "type-at",
      x: 10,
      y: 10,
      text: "a@b.co",
      commit: true,
    });

    expect(res.ok).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(model.committed).toBe("a@b.co");
    expect(document.activeElement).toBe(document.body);
  });

  it("type-at without commit leaves the field focused, as before", async () => {
    document.body.innerHTML = `<input id="email" />`;
    stubPoint(byId("email"));
    await performPointAction(document, { action: "type-at", x: 10, y: 10, text: "x" });
    expect(document.activeElement).toBe(byId("email"));
  });
});

describe("select-option moves focus with the same events", () => {
  it("unfocused: opening a focusable combobox gives the field that had focus its blur", async () => {
    document.body.innerHTML = `<input id="email" />
      <div id="combo" role="combobox" tabindex="0" data-bcmcp-uid="e2"><span class="select__singleValue"></span></div>
      <div role="listbox"><div role="option" id="opt">India</div></div>`;
    stamp(byId("email"), "e1");
    unfocused();
    const model = blurUpdate(byId<HTMLInputElement>("email"));
    performInputAction(document, { action: "fill", uid: "e1", value: "a@b.co" });
    byId("opt").addEventListener("click", () => {
      (document.querySelector(".select__singleValue") as HTMLElement).textContent = "India";
    });

    const res = await selectOption(document, { uid: "e2", option: "India" });

    expect(res.ok).toBe(true);
    expect(model.committed).toBe("a@b.co");
  });
});
