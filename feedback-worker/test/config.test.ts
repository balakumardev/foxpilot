import { describe, expect, it } from "vitest";
import { isTicketRef, parseLinearConfig } from "../src/config";
import { ASSIGNEE_ID, LABEL_BASE, LABEL_BUG, LABEL_FEATURE, TEAM_ID } from "./fakes";

function reason(raw: string | undefined): string {
  const result = parseLinearConfig(raw);
  if (result.ok) throw new Error("expected the config to be rejected");
  return result.reason;
}

describe("parseLinearConfig", () => {
  it("accepts a team alone", () => {
    expect(parseLinearConfig(JSON.stringify({ teamId: TEAM_ID }))).toEqual({
      ok: true,
      value: { teamId: TEAM_ID, labelIds: [], kindLabelIds: {} },
    });
  });

  it("accepts every field", () => {
    const value = {
      teamId: TEAM_ID,
      assigneeId: ASSIGNEE_ID,
      labelIds: [LABEL_BASE],
      kindLabelIds: { bug: LABEL_BUG, feature: LABEL_FEATURE, improvement: LABEL_BASE, other: ASSIGNEE_ID },
    };
    expect(parseLinearConfig(JSON.stringify(value))).toEqual({ ok: true, value });
  });

  it("accepts empty lists, upper-case ids and surrounding whitespace", () => {
    const result = parseLinearConfig(`\n ${JSON.stringify({ teamId: TEAM_ID.toUpperCase(), labelIds: [], kindLabelIds: {} })} \n`);
    expect(result.ok).toBe(true);
  });

  it.each([undefined, "", "   \n"])("rejects a missing config: %j", (raw) => {
    expect(reason(raw)).toBe("missing");
  });

  it.each(["{", "not json", "undefined", `{"teamId": "${TEAM_ID}"`])("rejects invalid JSON: %s", (raw) => {
    expect(reason(raw)).toBe("not valid JSON");
  });

  it.each(["null", "[]", `["${TEAM_ID}"]`, `"${TEAM_ID}"`, "42", "true"])("rejects a non-object: %s", (raw) => {
    expect(reason(raw)).toBe("not a JSON object");
  });

  it("rejects unknown top-level keys", () => {
    expect(reason(JSON.stringify({ teamId: TEAM_ID, projectId: TEAM_ID }))).toBe("unknown key");
    expect(reason(`{"teamId": "${TEAM_ID}", "__proto__": {}}`)).toBe("unknown key");
  });

  it.each([undefined, null, "", "team", 7, TEAM_ID.slice(1), `${TEAM_ID}0`, TEAM_ID.replace(/-/g, ""), [TEAM_ID]])(
    "rejects a teamId that is not a UUID: %j",
    (teamId) => {
      expect(reason(JSON.stringify({ teamId }))).toBe("teamId must be a UUID");
    }
  );

  it.each([null, "", "me", 5, [ASSIGNEE_ID]])("rejects an assigneeId that is not a UUID: %j", (assigneeId) => {
    expect(reason(JSON.stringify({ teamId: TEAM_ID, assigneeId }))).toBe("assigneeId must be a UUID");
  });

  it.each([null, "x", LABEL_BASE, {}, [1], ["nope"], [LABEL_BASE, "nope"], [[LABEL_BASE]]])(
    "rejects labelIds that are not an array of UUIDs: %j",
    (labelIds) => {
      expect(reason(JSON.stringify({ teamId: TEAM_ID, labelIds }))).toBe("labelIds must be an array of UUIDs");
    }
  );

  it.each([null, "bug", [LABEL_BUG], 3])("rejects kindLabelIds that is not an object: %j", (kindLabelIds) => {
    expect(reason(JSON.stringify({ teamId: TEAM_ID, kindLabelIds }))).toBe("kindLabelIds must be an object");
  });

  it("rejects an unknown kind", () => {
    expect(reason(JSON.stringify({ teamId: TEAM_ID, kindLabelIds: { question: LABEL_BUG } }))).toBe(
      "kindLabelIds has an unknown kind"
    );
    expect(reason(`{"teamId": "${TEAM_ID}", "kindLabelIds": {"__proto__": "${LABEL_BUG}"}}`)).toBe(
      "kindLabelIds has an unknown kind"
    );
  });

  it.each([null, "", "label", 1, [LABEL_BUG]])("rejects a kind label that is not a UUID: %j", (id) => {
    expect(reason(JSON.stringify({ teamId: TEAM_ID, kindLabelIds: { bug: id } }))).toBe(
      "kindLabelIds values must be UUIDs"
    );
  });

  it("never puts any of the config's content in the reason", () => {
    const secret = "SECRET-LOOKING-VALUE-123";
    const raws = [
      JSON.stringify({ teamId: secret }),
      JSON.stringify({ teamId: TEAM_ID, [secret]: 1 }),
      JSON.stringify({ teamId: TEAM_ID, labelIds: [secret] }),
      JSON.stringify({ teamId: TEAM_ID, kindLabelIds: { [secret]: LABEL_BUG } }),
      `{${secret}`,
    ];
    for (const raw of raws) expect(reason(raw)).not.toContain(secret);
  });
});

describe("isTicketRef", () => {
  it.each(["FP-1", "PER-123", "A-1", "ABCDEFG-999999999", "AB1-42"])("accepts %s", (ref) => {
    expect(isTicketRef(ref)).toBe(true);
  });

  it.each(["fp-1", "FP-0", "FP-01", "FP1", "-1", "FP-", "ABCDEFGH-1", "FP-1234567890", "FP-1 ", "<b>FP-1", "FP-1\n", null, 5, undefined])(
    "rejects %j",
    (ref) => {
      expect(isTicketRef(ref)).toBe(false);
    }
  );
});
