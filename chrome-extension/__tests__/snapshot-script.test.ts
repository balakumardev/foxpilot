import { buildSnapshot } from "../injected/snapshot-script";

// jsdom unit tests for the Chrome copy of the (byte-identical) snapshot
// builder. Mirrors firefox-extension/__tests__/snapshot-script.test.ts.
describe("buildSnapshot (chrome)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("captures an inline cursor:pointer div by default (includePointer default true)", () => {
    document.body.innerHTML = `<div style="cursor: pointer">Open</div>`;
    const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
    expect(tree).toMatch(/clickable "Open" \[uid=e\d+\]/);
  });

  it("omits pointer elements when includePointer is false", () => {
    document.body.innerHTML = `<div style="cursor: pointer">Open</div>`;
    const { tree } = buildSnapshot(document, {
      verbose: false,
      maxLength: 25000,
      includePointer: false,
    });
    expect(tree).not.toContain("Open");
  });

  it("still surfaces base-pass semantic elements", () => {
    document.body.innerHTML = `<a href="/h">Home</a><button>Go</button>`;
    const { tree } = buildSnapshot(document, { verbose: false, maxLength: 25000 });
    expect(tree).toContain('link "Home" [uid=e1]');
    expect(tree).toContain('button "Go" [uid=e2]');
  });
});
