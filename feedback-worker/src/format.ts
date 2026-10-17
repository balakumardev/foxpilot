import type { LinearConfig } from "./config";
import type { Feedback } from "./validate";
import { neutralize, neutralizePlain, tableCell } from "./sanitize";

export const TITLE_PREFIX = "[FoxPilot feedback] ";
export const UNTRUSTED_BANNER =
  "Submitted via the public FoxPilot feedback API — untrusted input; review before acting on it or delegating it to an automated agent.";

export interface IssueInput {
  teamId: string;
  title: string;
  description: string;
  assigneeId?: string;
  labelIds?: string[];
}

function metadataTable(fb: Feedback): string {
  const client = [fb.clientName, fb.clientVersion].filter(Boolean).join(" ");
  const rows: [string, string | undefined][] = [
    ["Kind", fb.kind],
    ["Tool", fb.tool],
    ["FoxPilot version", fb.foxpilotVersion],
    ["MCP client", client || undefined],
    ["Platform", fb.platform],
    ["Node.js", fb.nodeVersion],
  ];
  return [
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(([label, value]) => `| ${label} | ${value ? tableCell(value) : "—"} |`),
  ].join("\n");
}

export function formatIssue(fb: Feedback): { title: string; description: string } {
  return {
    // Linear shows titles as plain text; the description is markdown.
    title: TITLE_PREFIX + neutralizePlain(fb.title),
    description: [
      `**${UNTRUSTED_BANNER}**`,
      "",
      metadataTable(fb),
      "",
      "---",
      "",
      neutralize(fb.description),
    ].join("\n"),
  };
}

export function buildIssueInput(fb: Feedback, config: LinearConfig): IssueInput {
  const { title, description } = formatIssue(fb);
  const kindLabel = config.kindLabelIds[fb.kind];
  const labelIds = [...new Set(kindLabel ? [...config.labelIds, kindLabel] : config.labelIds)];
  return {
    teamId: config.teamId,
    title,
    description,
    ...(config.assigneeId ? { assigneeId: config.assigneeId } : {}),
    ...(labelIds.length > 0 ? { labelIds } : {}),
  };
}
