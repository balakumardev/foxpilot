import { typeCharStep } from "../injected/humanize-steps";

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
