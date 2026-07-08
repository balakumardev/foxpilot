import { formatEvalResult } from "../eval-format";

// Pins the evaluate-script result formatter (Fix 6). Mirrors the formatPointResult
// block in coordinate-tools.test.ts and formatSnapshotResult in
// snapshot-format.test.ts: server.ts self-executes on import and cannot be
// imported into a test, so the composed MCP tool result is exercised only
// through this pure function.
describe("formatEvalResult", () => {
  type Out = {
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
  };

  it("passes a string value through RAW (unquoted) with no structuredContent", () => {
    const out = formatEvalResult("hello world") as Out;
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text).toBe("hello world");
    expect(out.structuredContent).toBeUndefined();
  });

  it("does NOT double-encode an already-serialized JSON string (the () => JSON.stringify(state) regression)", () => {
    // A page fn `() => JSON.stringify(state)` returns THIS string; the model must
    // see it verbatim — not "{\"a\":1,\"b\":[2,3]}" wrapped and backslash-escaped
    // a second time (the pre-fix server.ts:608 `JSON.stringify(value)` bug).
    const serialized = JSON.stringify({ a: 1, b: [2, 3] }); // '{"a":1,"b":[2,3]}'
    const out = formatEvalResult(serialized) as Out;
    expect(out.content[0].text).toBe(serialized);
    expect(out.content[0].text).not.toContain('\\"'); // no escaped inner quotes
    expect(out.structuredContent).toBeUndefined();
  });

  it("pretty-prints a plain object (2-space indent) and mirrors it in structuredContent", () => {
    const value = { name: "Country", selected: "US" };
    const out = formatEvalResult(value) as Out;
    expect(out.content[0].text).toBe(JSON.stringify(value, null, 2));
    expect(out.content[0].text).toContain("\n"); // multi-line = pretty printed
    expect(out.structuredContent).toEqual(value);
  });

  it("pretty-prints an array but omits structuredContent (arrays are not a Record)", () => {
    const value = [1, 2, 3];
    const out = formatEvalResult(value) as Out;
    expect(out.content[0].text).toBe(JSON.stringify(value, null, 2));
    expect(out.structuredContent).toBeUndefined();
  });

  it("renders null as the JSON text \"null\" with no structuredContent", () => {
    const out = formatEvalResult(null) as Out;
    expect(out.content[0].text).toBe("null");
    expect(out.structuredContent).toBeUndefined();
  });

  it("renders undefined safely as a string (never undefined) with no structuredContent", () => {
    // JSON.stringify(undefined) is the JS value undefined; the formatter must
    // still yield a string. (In practice the extension coerces undefined -> null
    // on the wire — page-world.ts — so the runtime server rarely sees this; the
    // guard is defensive and unit-pinned here.)
    const out = formatEvalResult(undefined) as Out;
    expect(typeof out.content[0].text).toBe("string");
    expect(out.content[0].text).toBe("undefined");
    expect(out.structuredContent).toBeUndefined();
  });

  it("renders a number as its JSON text with no structuredContent", () => {
    const out = formatEvalResult(42) as Out;
    expect(out.content[0].text).toBe("42");
    expect(out.structuredContent).toBeUndefined();
  });

  it("renders a boolean as its JSON text with no structuredContent", () => {
    const out = formatEvalResult(true) as Out;
    expect(out.content[0].text).toBe("true");
    expect(out.structuredContent).toBeUndefined();
  });
});
