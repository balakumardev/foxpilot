import "../content-script";

/**
 * Typing into a contenteditable resolves later (the editor is checked for the
 * text before the reply), so performPointAction type-at, performInputAction
 * type and typeCharStep can return a Promise there. The content script must
 * await them: sendResponse(promise) reaches the background as {}. Driven
 * through the real onMessage listener the content script registers;
 * sendResponse is a jest.fn, so the test sees exactly the value handed to it
 * (a resolver would adopt a Promise and hide the bug).
 */
const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0] as (
  msg: unknown,
  sender: unknown,
  sendResponse: (r: unknown) => void
) => boolean;

// The reply comes back wrapped: returning a Promise from this async function
// would adopt it, and the test would never see that sendResponse got one.
async function send(msg: unknown): Promise<{ reply: unknown }> {
  const sendResponse = jest.fn();
  listener(msg, {}, sendResponse);
  for (let i = 0; i < 500 && sendResponse.mock.calls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(sendResponse).toHaveBeenCalledTimes(1);
  return { reply: sendResponse.mock.calls[0][0] };
}

function isThenable(v: unknown): boolean {
  return !!v && typeof (v as { then?: unknown }).then === "function";
}

describe("content script replies with the settled result of contenteditable typing", () => {
  afterEach(() => {
    delete (document as any).elementFromPoint;
    document.body.innerHTML = "";
  });

  it("performPointAction type-at", async () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true"></div>`;
    const ed = document.getElementById("ed")!;
    (document as any).elementFromPoint = jest.fn(() => ed);

    const { reply } = await send({
      type: "performPointAction",
      args: { action: "type-at", x: 1, y: 1, text: "hi" },
    });

    expect(isThenable(reply)).toBe(false);
    expect(reply).toMatchObject({ ok: true, element: { tag: "div" } });
    expect(ed.textContent).toBe("hi");
  });

  it("performInputAction type, including an ok:false the editor caused", async () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true" role="textbox"></div>`;
    const ed = document.getElementById("ed")!;
    ed.focus();
    ed.addEventListener("beforeinput", (e) => e.preventDefault());

    const { reply } = await send({
      type: "performInputAction",
      args: { action: "type", text: "hi" },
    });

    expect(isThenable(reply)).toBe(false);
    expect(reply).toMatchObject({ ok: false });
    expect((reply as { error: string }).error).toMatch(
      /^The editor did not keep the typed text: <div role="textbox">/
    );
  });

  it("typeCharStep", async () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true"></div>`;
    const ed = document.getElementById("ed")!;
    ed.focus();

    const { reply } = await send({ type: "typeCharStep", char: "x" });

    expect(isThenable(reply)).toBe(false);
    expect(reply).toEqual({ ok: true });
    expect(ed.textContent).toBe("x");
  });

  it("runHumanInput type-text types every character through the awaited steps", async () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true"></div>`;
    const ed = document.getElementById("ed")!;
    ed.focus();

    const { reply } = await send({
      type: "runHumanInput",
      args: { action: "type", text: "ok" },
      cursor: { x: 0, y: 0 },
    });

    expect(reply).toEqual({ ok: true });
    expect(ed.textContent).toBe("ok");
  });
});
