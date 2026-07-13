import {
  dispatchMouseMoveStep,
  typeCharStep,
  readElementScreenRect,
} from "../injected/humanize-steps";

describe("humanize-steps (injected, jsdom)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("dispatchMouseMoveStep", () => {
    it("dispatches a mousemove carrying the coordinates", () => {
      let seen: MouseEvent | null = null;
      document.addEventListener("mousemove", (e) => (seen = e as MouseEvent), {
        once: true,
      });

      const res = dispatchMouseMoveStep(document, 40, 25);

      expect(res.ok).toBe(true);
      expect(seen).not.toBeNull();
      expect(seen!.clientX).toBe(40);
      expect(seen!.clientY).toBe(25);
    });
  });

  describe("typeCharStep", () => {
    it("appends one char to the focused field and fires keydown/input/keyup", () => {
      document.body.innerHTML = `<input type="text" value="ab" />`;
      const input = document.querySelector("input")!;
      input.focus();
      const events: string[] = [];
      ["keydown", "input", "keyup"].forEach((t) =>
        input.addEventListener(t, () => events.push(t))
      );

      const res = typeCharStep(document, "c");

      expect(res.ok).toBe(true);
      expect(input.value).toBe("abc");
      expect(events).toEqual(expect.arrayContaining(["keydown", "input", "keyup"]));
    });

    it("returns ok:false when no input/textarea is focused", () => {
      document.body.innerHTML = `<div>not a field</div>`;
      const res = typeCharStep(document, "x");
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe("string");
    });
  });

  describe("readElementScreenRect", () => {
    it("returns null for a missing uid", () => {
      expect(readElementScreenRect(document, "nope")).toBeNull();
    });
    it("returns a screen rect for a stamped element (client coords when no mozInnerScreen offset)", () => {
      document.body.innerHTML = `<button data-bcmcp-uid="e1">x</button>`;
      const r = readElementScreenRect(document, "e1");
      expect(r).not.toBeNull();
      expect(typeof r!.screenX).toBe("number");
      expect(typeof r!.dpr).toBe("number");
    });
  });
});

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
