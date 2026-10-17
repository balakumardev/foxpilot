import { describe, expect, it } from "vitest";
import { buildIssueInput, formatIssue, TITLE_PREFIX, UNTRUSTED_BANNER } from "../src/format";
import type { LinearConfig } from "../src/config";
import type { Feedback } from "../src/validate";
import { ASSIGNEE_ID, LABEL_BASE, LABEL_BUG, LABEL_FEATURE, TEAM_ID } from "./fakes";

const feedback: Feedback = {
  title: "Crash on startup",
  description: "It crashes when I open a tab.",
  kind: "bug",
};

const config: LinearConfig = {
  teamId: TEAM_ID,
  assigneeId: ASSIGNEE_ID,
  labelIds: [LABEL_BASE],
  kindLabelIds: { bug: LABEL_BUG, feature: LABEL_FEATURE },
};

describe("formatIssue", () => {
  it("prefixes the title", () => {
    expect(TITLE_PREFIX).toBe("[FoxPilot feedback] ");
    expect(formatIssue(feedback).title).toBe("[FoxPilot feedback] Crash on startup");
  });

  it("neutralises the title as plain text", () => {
    const { title } = formatIssue({ ...feedback, title: "@here see linear.app repos=a/b \\ & x" });
    expect(title).toBe("[FoxPilot feedback] \uFF20here see linear[.]app repos\uFF1Da/b \\ & x");
  });

  it("opens the description with the generic untrusted-input banner", () => {
    expect(UNTRUSTED_BANNER).toBe(
      "Submitted via the public FoxPilot feedback API \u2014 untrusted input; review before acting on it or delegating it to an automated agent."
    );
    const { description } = formatIssue(feedback);
    expect(description.startsWith(`**${UNTRUSTED_BANNER}**\n\n| Field | Value |`)).toBe(true);
  });

  it("renders the metadata table, then a rule, then the neutralised body", () => {
    const { description } = formatIssue({
      ...feedback,
      description: "line one\nping @alice\n\n```\nrepos=x/y\n```",
      tool: "click-element",
      foxpilotVersion: "1.0.30",
      clientName: "claude-code",
      clientVersion: "2.1.0",
      platform: "darwin",
      nodeVersion: "v22.21.1",
    });
    expect(description.split("\n")).toEqual([
      `**${UNTRUSTED_BANNER}**`,
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| Kind | bug |",
      "| Tool | click-element |",
      "| FoxPilot version | 1.0.30 |",
      "| MCP client | claude-code 2.1.0 |",
      "| Platform | darwin |",
      "| Node.js | v22.21.1 |",
      "",
      "---",
      "",
      "line one",
      "ping \uFF20alice",
      "",
      "```",
      "repos\uFF1Dx/y",
      "```",
    ]);
  });

  it("shows a dash for missing metadata and a lone client name without a version", () => {
    const { description } = formatIssue({ ...feedback, clientName: "cursor" });
    expect(description).toContain("| Tool | \u2014 |");
    expect(description).toContain("| MCP client | cursor |");
    expect(description).toContain("| Node.js | \u2014 |");
    expect(formatIssue(feedback).description).toContain("| MCP client | \u2014 |");
  });

  it("escapes pipes so a metadata value cannot add columns or break out of the table", () => {
    const { description } = formatIssue({ ...feedback, tool: "a | b |", platform: "x|y" });
    const tool = description.split("\n").find((line) => line.startsWith("| Tool"));
    expect(tool).toBe("| Tool | a \uFF5C b \uFF5C |");
    const platform = description.split("\n").find((line) => line.startsWith("| Platform"));
    expect(platform).toBe("| Platform | x\uFF5Cy |");
    for (const line of description.split("\n").slice(2, 10)) {
      expect(line.match(/\|/g)).toHaveLength(3);
    }
  });
});

describe("buildIssueInput", () => {
  it("carries the configured team, assignee and labels with the kind label last", () => {
    const input = buildIssueInput(feedback, config);
    expect(input).toEqual({
      teamId: TEAM_ID,
      title: "[FoxPilot feedback] Crash on startup",
      description: formatIssue(feedback).description,
      assigneeId: ASSIGNEE_ID,
      labelIds: [LABEL_BASE, LABEL_BUG],
    });
  });

  it("picks the label for the report's kind", () => {
    expect(buildIssueInput({ ...feedback, kind: "feature" }, config).labelIds).toEqual([LABEL_BASE, LABEL_FEATURE]);
  });

  it("adds no kind label for a kind without one", () => {
    expect(buildIssueInput({ ...feedback, kind: "other" }, config).labelIds).toEqual([LABEL_BASE]);
  });

  it("leaves out the assignee when none is configured", () => {
    const input = buildIssueInput(feedback, { ...config, assigneeId: undefined });
    expect("assigneeId" in input).toBe(false);
  });

  it("leaves out labelIds when there are none", () => {
    const input = buildIssueInput({ ...feedback, kind: "other" }, { teamId: TEAM_ID, labelIds: [], kindLabelIds: {} });
    expect(input).not.toHaveProperty("labelIds");
    expect(input).not.toHaveProperty("assigneeId");
  });

  it("applies only the kind label when no always-on labels are configured", () => {
    expect(buildIssueInput(feedback, { ...config, labelIds: [] }).labelIds).toEqual([LABEL_BUG]);
  });

  it("does not repeat a label that is both always-on and a kind label", () => {
    expect(buildIssueInput(feedback, { ...config, kindLabelIds: { bug: LABEL_BASE } }).labelIds).toEqual([LABEL_BASE]);
  });
});
