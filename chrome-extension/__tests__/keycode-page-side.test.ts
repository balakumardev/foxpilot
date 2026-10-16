import { performInputAction } from "../injected/action-script";
import { performPointAction } from "../injected/point-action-script";
import { typeCharStep } from "../injected/humanize-steps";

/**
 * PER-12, related gap 5: a synthetic Escape did not close Play Console or
 * Drive menus on Firefox. Their code reads event.keyCode, and in a Firefox
 * content script the keyCode FoxPilot defines lands on the Xray view of the
 * event, so page code read 0. Verified on Firefox 157: a keyCode defined on
 * the event's wrappedJSObject is what a page listener reads. jsdom has no Xray
 * split, so the page-side object is simulated: a wrappedJSObject getter that
 * hands out one plain object per event.
 */
const pageSide = new WeakMap<Event, Record<string, unknown>>();

beforeAll(() => {
  Object.defineProperty(KeyboardEvent.prototype, "wrappedJSObject", {
    configurable: true,
    get(this: KeyboardEvent) {
      let o = pageSide.get(this);
      if (!o) {
        o = {};
        pageSide.set(this, o);
      }
      return o;
    },
  });
});

afterAll(() => {
  delete (KeyboardEvent.prototype as any).wrappedJSObject;
});

afterEach(() => {
  document.body.innerHTML = "";
  (document as any).elementFromPoint = undefined;
});

// What a page-world listener would read: keyCode and which off the page-side
// object of every keydown the target saw.
function pageKeyCodes(target: EventTarget): string[] {
  const seen: string[] = [];
  target.addEventListener("keydown", (e) => {
    const p = pageSide.get(e) || {};
    seen.push(`${(e as KeyboardEvent).key}:${String(p.keyCode)}:${String(p.which)}`);
  });
  return seen;
}

it("press-key gives the page-side event the key's keyCode and which", () => {
  document.body.innerHTML = `<input id="q" />`;
  const q = document.getElementById("q") as HTMLInputElement;
  q.focus();
  const seen = pageKeyCodes(q);

  performInputAction(document, { action: "press-key", key: "Escape" });
  performInputAction(document, { action: "press-key", key: "Enter" });

  expect(seen).toEqual(["Escape:27:27", "Enter:13:13"]);
});

it("type-text keys carry it too", () => {
  document.body.innerHTML = `<input id="q" />`;
  const q = document.getElementById("q") as HTMLInputElement;
  q.focus();
  const seen = pageKeyCodes(q);

  performInputAction(document, { action: "type", text: "a" });

  expect(seen).toEqual(["a:65:65"]);
});

it("type-at keys carry it too", async () => {
  document.body.innerHTML = `<input id="q" />`;
  const q = document.getElementById("q") as HTMLInputElement;
  (document as any).elementFromPoint = jest.fn(() => q);
  const seen = pageKeyCodes(q);

  await performPointAction(document, { action: "type-at", x: 1, y: 1, text: "b", submit: true });

  expect(seen).toEqual(["b:66:66", "Enter:13:13"]);
});

it("the humanized per-character step carries it too", async () => {
  document.body.innerHTML = `<input id="q" />`;
  const q = document.getElementById("q") as HTMLInputElement;
  q.focus();
  const seen = pageKeyCodes(q);

  await typeCharStep(document, "c");

  expect(seen).toEqual(["c:67:67"]);
});
