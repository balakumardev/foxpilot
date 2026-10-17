import { buildFeedbackPayload, FEEDBACK_LIMITS, FeedbackInput } from "../feedback-client";

const GHP = "gh" + "p_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";

const base: FeedbackInput = {
  kind: "bug",
  title: "click-element reports success but nothing happens",
  description: "I called click-element on a menu item and it answered Clicked element e2, but the menu did not open.",
};

function ok(r: ReturnType<typeof buildFeedbackPayload>) {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
}

describe("buildFeedbackPayload", () => {
  it("builds the minimal payload", () => {
    const r = ok(buildFeedbackPayload(base));
    expect(r.payload).toEqual({ kind: "bug", title: base.title, description: base.description });
    expect(r.redactions).toBe(0);
    expect(r.truncated).toEqual([]);
  });

  it("adds the tool and metadata fields", () => {
    const r = ok(
      buildFeedbackPayload(
        { ...base, tool: "click-element" },
        {
          foxpilotVersion: "1.0.30",
          clientName: "claude-code",
          clientVersion: "2.5.1",
          platform: "darwin-arm64",
          nodeVersion: "v22.21.1",
        }
      )
    );
    expect(r.payload).toEqual({
      kind: "bug",
      title: base.title,
      description: base.description,
      tool: "click-element",
      foxpilotVersion: "1.0.30",
      clientName: "claude-code",
      clientVersion: "2.5.1",
      platform: "darwin-arm64",
      nodeVersion: "v22.21.1",
    });
  });

  it("sends only the API's fields: userApproved and other extras never reach the payload", () => {
    const input = { ...base, userApproved: true, extra: "x", __proto_: 1 } as unknown as FeedbackInput;
    const r = ok(buildFeedbackPayload(input, { clientName: "c" }));
    const allowed = new Set([
      "kind", "title", "description", "tool", "foxpilotVersion", "clientName", "clientVersion", "platform", "nodeVersion",
    ]);
    for (const key of Object.keys(r.payload)) expect(allowed.has(key)).toBe(true);
    expect(JSON.stringify(r.payload)).not.toContain("userApproved");
    expect(JSON.stringify(r.payload)).not.toContain("extra");
  });

  it("omits undefined, empty and blank optional fields", () => {
    const r = ok(
      buildFeedbackPayload(
        { ...base, tool: "   " },
        { clientName: undefined, clientVersion: "", platform: "   ", nodeVersion: undefined }
      )
    );
    expect(Object.keys(r.payload).sort()).toEqual(["description", "kind", "title"]);
  });

  it("redacts title, description and tool, and counts them", () => {
    const r = ok(
      buildFeedbackPayload({
        kind: "other",
        title: "Crash when opening https://app.example.com/x?token=abc123",
        description: `Pasted by mistake: ${GHP}\nand a@b.io at /Users/bob/code/app.ts`,
        tool: "Cookie: a=b",
      })
    );
    expect(r.payload.title).toBe("Crash when opening https://app.example.com/x?[redacted]");
    expect(r.payload.description).toBe("Pasted by mistake: [redacted]\nand [email] at ~/code/app.ts");
    expect(r.payload.tool).toBe("Cookie: [redacted]");
    expect(r.redactions).toBe(5);
    expect(JSON.stringify(r.payload)).not.toContain(GHP);
  });

  it("redacts before applying limits: a marker longer than its match cannot push past the cap", () => {
    // "a@b.co " is 7 characters; "[email] " is 8.
    const description = "a@b.co ".repeat(1100); // 7700 chars in, 8800 out
    const r = ok(buildFeedbackPayload({ ...base, description }));
    expect(r.payload.description.length).toBe(FEEDBACK_LIMITS.descriptionMax);
    expect(r.truncated).toEqual(["description"]);
    expect(r.payload.description.endsWith("…")).toBe(true);
  });

  it("keeps the title within 140 characters", () => {
    const r = ok(buildFeedbackPayload({ ...base, title: "x".repeat(300) }));
    expect(r.payload.title.length).toBe(FEEDBACK_LIMITS.titleMax);
    expect(r.truncated).toContain("title");
  });

  it("does not split a surrogate pair when it truncates", () => {
    const r = ok(buildFeedbackPayload({ ...base, title: "😀".repeat(100) }));
    expect(r.payload.title.length).toBeLessThanOrEqual(FEEDBACK_LIMITS.titleMax);
    // Round-trips as valid UTF-16: no lone surrogate.
    expect(JSON.parse(JSON.stringify(r.payload.title))).toBe(r.payload.title);
    expect(Buffer.from(r.payload.title, "utf8").toString("utf8")).toBe(r.payload.title);
  });

  it("truncates tool and every metadata field to 64 characters", () => {
    const long = "m".repeat(200);
    const r = ok(
      buildFeedbackPayload(
        { ...base, tool: "t".repeat(100) },
        { foxpilotVersion: long, clientName: long, clientVersion: long, platform: long, nodeVersion: long }
      )
    );
    expect(r.payload.tool).toHaveLength(64);
    expect(r.truncated).toContain("tool");
    for (const key of ["foxpilotVersion", "clientName", "clientVersion", "platform", "nodeVersion"] as const) {
      expect(r.payload[key]).toHaveLength(64);
    }
  });

  it("collapses whitespace in the title and strips control characters", () => {
    const r = ok(
      buildFeedbackPayload(
        {
          ...base,
          title: "  line one\n\tline   two\u0000\u0007  ",
          description: "first\r\nsecond\u0000 line\u001b[31m red\tkept tab\n\nthird and more",
        },
        { clientName: "a\nb\u0000c" }
      )
    );
    expect(r.payload.title).toBe("line one line two");
    expect(r.payload.description).toBe("first\nsecond line[31m red\tkept tab\n\nthird and more");
    expect(r.payload.clientName).toBe("a bc");
  });

  it("fails clearly when redaction leaves the title or description too short", () => {
    // A home-directory path collapses to a single "~".
    const t = buildFeedbackPayload({ ...base, title: "/Users/bob" });
    expect(t).toEqual({ ok: false, error: expect.stringContaining("title") });
    const d = buildFeedbackPayload({ ...base, description: "/Users/bob" });
    expect(d).toEqual({ ok: false, error: expect.stringContaining("description") });
    expect((d as { error: string }).error).toContain("Nothing was sent");
  });

  it("also rejects text that was already too short before redaction", () => {
    expect(buildFeedbackPayload({ ...base, title: "ab" }).ok).toBe(false);
    expect(buildFeedbackPayload({ ...base, description: "too short" }).ok).toBe(false);
  });

  it("rejects an unknown kind", () => {
    const r = buildFeedbackPayload({ ...base, kind: "complaint" as never });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("kind") });
  });

  it.each(["bug", "feature", "improvement", "other"] as const)("accepts kind %s", (kind) => {
    expect(ok(buildFeedbackPayload({ ...base, kind })).payload.kind).toBe(kind);
  });

  it("serialises well under the server's 64 KB body cap at the maximum size", () => {
    const quotes = '"\\'.repeat(FEEDBACK_LIMITS.descriptionMax / 2); // worst case for JSON escaping
    const r = ok(buildFeedbackPayload({ ...base, title: "😀".repeat(70), description: quotes }));
    expect(Buffer.byteLength(JSON.stringify(r.payload))).toBeLessThan(64 * 1024);
  });
});
