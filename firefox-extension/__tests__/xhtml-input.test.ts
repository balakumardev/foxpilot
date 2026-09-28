/**
 * @jest-environment-options {"html": "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head></head><body></body></html>", "contentType": "application/xhtml+xml"}
 */
import { performInputAction } from "../injected/action-script";

/**
 * In an application/xhtml+xml document an element's tagName is its qualified
 * name as written ("input"), not the uppercased HTML-document form ("INPUT"),
 * so a tagName === "INPUT" test silently fails there. This file runs in a real
 * XHTML document (see the environment options above) and pins that fill and
 * type still work on its form fields. Identical file in the Firefox and Chrome
 * suites.
 */
describe("fill / type in an XHTML document", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function byId<T extends Element>(id: string): T {
    return document.getElementById(id) as unknown as T;
  }

  it("really is an XHTML document (tagName keeps its lowercase spelling)", () => {
    document.body.innerHTML = `<input id="q" type="text" />`;
    expect(document.contentType).toBe("application/xhtml+xml");
    expect(byId<Element>("q").tagName).toBe("input");
  });

  it("fills a text input", () => {
    document.body.innerHTML = `<input id="q" type="text" data-bcmcp-uid="e1" />`;
    const res = performInputAction(document, { action: "fill", uid: "e1", value: "hello" });
    expect(res).toEqual({ ok: true });
    expect(byId<HTMLInputElement>("q").value).toBe("hello");
  });

  it("fills a textarea", () => {
    document.body.innerHTML = `<textarea id="t" data-bcmcp-uid="e1"></textarea>`;
    const res = performInputAction(document, { action: "fill", uid: "e1", value: "two\nlines" });
    expect(res).toEqual({ ok: true });
    expect(byId<HTMLTextAreaElement>("t").value).toBe("two\nlines");
  });

  it("checks a checkbox through its real click", () => {
    document.body.innerHTML = `<input id="c" type="checkbox" data-bcmcp-uid="e1" />`;
    let changes = 0;
    byId<Element>("c").addEventListener("change", () => changes++);
    const res = performInputAction(document, { action: "fill", uid: "e1", value: "true" });
    expect(res).toEqual({ ok: true });
    expect(byId<HTMLInputElement>("c").checked).toBe(true);
    expect(changes).toBe(1);
  });

  it("selects an option by its visible text", () => {
    document.body.innerHTML = `<select id="s" data-bcmcp-uid="e1"><option value="us">United States</option><option value="in">India</option></select>`;
    const res = performInputAction(document, { action: "fill", uid: "e1", value: "India" });
    expect(res).toEqual({ ok: true });
    expect(byId<HTMLSelectElement>("s").value).toBe("in");
  });

  it("types into the focused input", () => {
    document.body.innerHTML = `<input id="q" type="text" value="ab" />`;
    byId<HTMLInputElement>("q").focus();
    const res = performInputAction(document, { action: "type", text: "cd" });
    expect(res).toEqual({ ok: true });
    expect(byId<HTMLInputElement>("q").value).toBe("abcd");
  });

  it("a click on a checkbox's label toggles it exactly once", () => {
    document.body.innerHTML = `<label data-bcmcp-uid="e1"><input id="c" type="checkbox" /> Accept</label>`;
    let changes = 0;
    byId<Element>("c").addEventListener("change", () => changes++);
    performInputAction(document, { action: "click", uid: "e1" });
    expect(byId<HTMLInputElement>("c").checked).toBe(true);
    expect(changes).toBe(1);
  });
});
