import { describe, expect, it } from "vitest";
import { validateFeedback } from "../src/validate";

const base = { title: "Crash on startup", description: "It crashes when I open a tab.", kind: "bug" };

function error(input: unknown): string {
  const result = validateFeedback(input);
  if (result.ok) throw new Error("expected a validation error");
  return result.error;
}

describe("validateFeedback", () => {
  it("accepts the minimal body", () => {
    expect(validateFeedback(base)).toEqual({ ok: true, value: base });
  });

  it("accepts every optional metadata field", () => {
    const meta = {
      tool: "click-element",
      foxpilotVersion: "1.0.30",
      clientName: "claude-code",
      clientVersion: "2.1.0",
      platform: "darwin",
      nodeVersion: "v22.21.1",
    };
    expect(validateFeedback({ ...base, ...meta })).toEqual({ ok: true, value: { ...base, ...meta } });
  });

  it.each([null, [], ["title"], "text", 42, true])("rejects a non-object body: %j", (input) => {
    expect(error(input)).toBe("body must be a JSON object");
  });

  describe("unknown fields", () => {
    it("rejects them and lists the allowed ones", () => {
      const message = error({ ...base, severity: "high" });
      expect(message).toContain('unknown field "severity"');
      expect(message).toContain("title, description, kind, tool");
    });

    it("rejects a __proto__ key that JSON.parse creates as an own property", () => {
      expect(error(JSON.parse('{"__proto__": {"kind": "bug"}, "title": "abc", "description": "0123456789", "kind": "bug"}'))).toContain(
        'unknown field "__proto__"'
      );
    });

    it("cleans and truncates the key it echoes back", () => {
      const message = error({ ...base, [`bad\u0000\u202Ekey${"x".repeat(100)}`]: 1 });
      expect(message).toContain(`unknown field "badkey${"x".repeat(34)}"`);
      expect(message).not.toMatch(/[\u0000\u202E]/);
    });
  });

  describe("title", () => {
    it("is required and must be a string", () => {
      expect(error({ ...base, title: undefined })).toBe("title is required and must be a string");
      expect(error({ ...base, title: 123 })).toBe("title is required and must be a string");
      expect(error({ ...base, title: null })).toBe("title is required and must be a string");
    });

    it("must be 3 to 140 characters", () => {
      expect(error({ ...base, title: "ab" })).toBe("title must be 3-140 characters");
      expect(validateFeedback({ ...base, title: "abc" }).ok).toBe(true);
      expect(validateFeedback({ ...base, title: "a".repeat(140) }).ok).toBe(true);
      expect(error({ ...base, title: "a".repeat(141) })).toBe("title must be 3-140 characters");
    });

    it("is measured after cleaning, and collapsed to one line", () => {
      const result = validateFeedback({ ...base, title: "  a \n\t b\u200B  c  " });
      expect(result).toMatchObject({ ok: true, value: { title: "a b c" } });
      expect(error({ ...base, title: "\u200B\u200B\u200B\u200B" })).toBe("title must be 3-140 characters");
      expect(validateFeedback({ ...base, title: "a".repeat(140) + "\u200B".repeat(50) }).ok).toBe(true);
    });
  });

  describe("description", () => {
    it("is required and must be a string", () => {
      expect(error({ ...base, description: undefined })).toBe("description is required and must be a string");
      expect(error({ ...base, description: ["x"] })).toBe("description is required and must be a string");
    });

    it("must be 10 to 8000 characters", () => {
      expect(error({ ...base, description: "123456789" })).toBe("description must be 10-8000 characters");
      expect(validateFeedback({ ...base, description: "1234567890" }).ok).toBe(true);
      expect(validateFeedback({ ...base, description: "a".repeat(8000) }).ok).toBe(true);
      expect(error({ ...base, description: "a".repeat(8001) })).toBe("description must be 10-8000 characters");
    });

    it("keeps line breaks, trims the ends and drops hidden characters", () => {
      const result = validateFeedback({ ...base, description: "\n  line one\r\nline\u200B two\u2028line three  \n" });
      expect(result).toMatchObject({ ok: true, value: { description: "line one\nline two\nline three" } });
    });
  });

  describe("kind", () => {
    it.each(["bug", "feature", "improvement", "other"])("accepts %s", (kind) => {
      expect(validateFeedback({ ...base, kind }).ok).toBe(true);
    });

    it.each([undefined, null, 1, "Bug", "BUG", "question", "", ["bug"]])("rejects %j", (kind) => {
      expect(error({ ...base, kind })).toBe("kind must be one of: bug, feature, improvement, other");
    });
  });

  describe("metadata fields", () => {
    const fields = ["tool", "foxpilotVersion", "clientName", "clientVersion", "platform", "nodeVersion"];

    it.each(fields)("%s may be 64 characters but not 65", (field) => {
      expect(validateFeedback({ ...base, [field]: "v".repeat(64) }).ok).toBe(true);
      expect(error({ ...base, [field]: "v".repeat(65) })).toBe(`${field} must be at most 64 characters`);
    });

    it.each(fields)("%s must be a string", (field) => {
      for (const value of [1, true, null, ["x"], { a: 1 }]) {
        expect(error({ ...base, [field]: value })).toBe(`${field} must be a string`);
      }
    });

    it("drops values that are empty after cleaning, and collapses whitespace in the rest", () => {
      const result = validateFeedback({ ...base, tool: "  \u200B \n", platform: "mac\nOS\t14" });
      expect(result).toEqual({ ok: true, value: { ...base, platform: "mac OS 14" } });
    });

    it("measures the length after cleaning", () => {
      expect(validateFeedback({ ...base, tool: "v".repeat(64) + "\u200B".repeat(20) }).ok).toBe(true);
    });
  });
});
