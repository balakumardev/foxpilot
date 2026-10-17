import { DEFAULT_FEEDBACK_URL, resolveFeedbackEndpoint } from "../feedback-client";

// Which URL send-feedback talks to, and whether it may talk at all.
describe("resolveFeedbackEndpoint", () => {
  it("defaults to the public worker when nothing is set", () => {
    expect(resolveFeedbackEndpoint({})).toEqual({ status: "ok", url: DEFAULT_FEEDBACK_URL });
    expect(DEFAULT_FEEDBACK_URL).toBe(
      "https://foxpilot-feedback.co-balakumar.workers.dev/v1/feedback"
    );
  });

  it("treats an empty or blank override as unset", () => {
    expect(resolveFeedbackEndpoint({ FOXPILOT_FEEDBACK_URL: "" })).toEqual({
      status: "ok",
      url: DEFAULT_FEEDBACK_URL,
    });
    expect(resolveFeedbackEndpoint({ FOXPILOT_FEEDBACK_URL: "   " })).toEqual({
      status: "ok",
      url: DEFAULT_FEEDBACK_URL,
    });
  });

  it("honours an https override", () => {
    expect(
      resolveFeedbackEndpoint({ FOXPILOT_FEEDBACK_URL: "https://feedback.example.org/v1/feedback" })
    ).toEqual({ status: "ok", url: "https://feedback.example.org/v1/feedback" });
  });

  it.each([
    "http://localhost:8787/v1/feedback",
    "http://127.0.0.1:9000/v1/feedback",
    "http://[::1]:9000/v1/feedback",
  ])("allows plain http only for loopback: %s", (url) => {
    expect(resolveFeedbackEndpoint({ FOXPILOT_FEEDBACK_URL: url })).toEqual({ status: "ok", url });
  });

  it.each([
    "http://example.com/v1/feedback",
    "http://localhost.evil.com/v1/feedback",
    "http://127.0.0.1.evil.com/",
    "http://10.0.0.5/v1/feedback",
    "ftp://example.com/feedback",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "//example.com/feedback",
  ])("rejects %s and never falls back to the default", (url) => {
    const r = resolveFeedbackEndpoint({ FOXPILOT_FEEDBACK_URL: url });
    expect(r.status).toBe("invalid");
    expect(r).toHaveProperty("error");
  });

  it("rejects credentials in the URL without echoing them", () => {
    const r = resolveFeedbackEndpoint({
      FOXPILOT_FEEDBACK_URL: "https://admin:hunter2pw@feedback.example.org/x",
    });
    expect(r.status).toBe("invalid");
    expect(JSON.stringify(r)).not.toContain("hunter2pw");
    expect(JSON.stringify(r)).not.toContain("admin");
  });

  it("names the offending scheme and host, never the path or query", () => {
    const r = resolveFeedbackEndpoint({
      FOXPILOT_FEEDBACK_URL: "http://example.com/v1/feedback?key=abc123secret",
    });
    expect(r).toMatchObject({ status: "invalid" });
    const error = (r as { error: string }).error;
    expect(error).toContain("example.com");
    expect(error).not.toContain("abc123secret");
  });

  it.each(["off", "OFF", "Off", "0", "false", "FALSE", "disabled", "Disabled", "  off  "])(
    "FOXPILOT_FEEDBACK=%j disables sending",
    (value) => {
      expect(resolveFeedbackEndpoint({ FOXPILOT_FEEDBACK: value })).toEqual({ status: "disabled" });
    }
  );

  it.each(["on", "1", "true", "", "yes", "enabled"])(
    "FOXPILOT_FEEDBACK=%j leaves sending on",
    (value) => {
      expect(resolveFeedbackEndpoint({ FOXPILOT_FEEDBACK: value })).toEqual({
        status: "ok",
        url: DEFAULT_FEEDBACK_URL,
      });
    }
  );

  it("the off switch wins over an invalid override", () => {
    expect(
      resolveFeedbackEndpoint({
        FOXPILOT_FEEDBACK: "off",
        FOXPILOT_FEEDBACK_URL: "http://example.com/",
      })
    ).toEqual({ status: "disabled" });
  });
});
