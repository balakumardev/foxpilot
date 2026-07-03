import { formatNetworkHeaders, SENSITIVE_HEADER } from "../network-format";

describe("formatNetworkHeaders", () => {
  const headers = [
    { name: "Content-Type", value: "application/json" },
    { name: "Cookie", value: "sid=abcdef" }, // 10 chars
    { name: "Authorization", value: "Bearer xyz" }, // 10 chars
  ];

  it("redacts credential headers by default (includeCredentials false)", () => {
    const out = formatNetworkHeaders("request headers", headers, false);
    expect(out).toContain("Content-Type: application/json");
    expect(out).toContain("Cookie: <redacted:10 chars>");
    expect(out).toContain("Authorization: <redacted:10 chars>");
    expect(out).not.toContain("sid=abcdef");
    expect(out).not.toContain("Bearer xyz");
  });

  it("prints raw credential values when includeCredentials is true", () => {
    const out = formatNetworkHeaders("request headers", headers, true);
    expect(out).toContain("Cookie: sid=abcdef");
    expect(out).toContain("Authorization: Bearer xyz");
    expect(out).not.toContain("<redacted");
  });

  it("returns an empty string for no headers", () => {
    expect(formatNetworkHeaders("request headers", undefined, false)).toBe("");
    expect(formatNetworkHeaders("request headers", [], true)).toBe("");
  });

  it("SENSITIVE_HEADER matches the credential header names case-insensitively", () => {
    expect(SENSITIVE_HEADER.test("set-cookie")).toBe(true);
    expect(SENSITIVE_HEADER.test("Proxy-Authorization")).toBe(true);
    expect(SENSITIVE_HEADER.test("content-type")).toBe(false);
  });
});
