export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export const KINDS = ["bug", "feature", "improvement", "other"] as const;
export type Kind = (typeof KINDS)[number];

export const FEEDBACK_PATH = "/v1/feedback";
export const MAX_BODY_BYTES = 64 * 1024;
export const TITLE_MIN = 3;
export const TITLE_MAX = 140;
export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 8000;
export const META_MAX = 64;

export const BURST_RETRY_AFTER_SECONDS = 60;
export const IP_DAILY_CAP = 10;
export const GLOBAL_DAILY_CAP = 100;
export const DEDUPE_TTL_SECONDS = 24 * 60 * 60;
export const SUBMISSION_TTL_SECONDS = 2 * 24 * 60 * 60;
export const LINEAR_TIMEOUT_MS = 8000;
export const IP_HASH_KEY_MIN_LENGTH = 32;

export function isTicketRef(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9]{0,6}-[1-9][0-9]{0,8}$/.test(value);
}

export interface LinearConfig {
  teamId: string;
  assigneeId?: string;
  /** Applied to every issue. */
  labelIds: string[];
  /** Applied on top of labelIds for reports of that kind; a missing kind adds nothing. */
  kindLabelIds: Partial<Record<Kind, string>>;
}

export type ConfigResult = { ok: true; value: LinearConfig } | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOP_LEVEL_KEYS = new Set(["teamId", "assigneeId", "labelIds", "kindLabelIds"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/**
 * Parses the LINEAR_CONFIG secret. Reasons are static strings: they are logged, and the
 * secret's content must never reach a log line.
 */
export function parseLinearConfig(raw: string | undefined): ConfigResult {
  const text = raw?.trim();
  if (!text) return { ok: false, reason: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: "not a JSON object" };
  if (Object.keys(parsed).some((key) => !TOP_LEVEL_KEYS.has(key))) {
    return { ok: false, reason: "unknown key" };
  }

  if (!isUuid(parsed.teamId)) return { ok: false, reason: "teamId must be a UUID" };
  const value: LinearConfig = { teamId: parsed.teamId, labelIds: [], kindLabelIds: {} };

  if (parsed.assigneeId !== undefined) {
    if (!isUuid(parsed.assigneeId)) return { ok: false, reason: "assigneeId must be a UUID" };
    value.assigneeId = parsed.assigneeId;
  }

  if (parsed.labelIds !== undefined) {
    if (!Array.isArray(parsed.labelIds) || !parsed.labelIds.every(isUuid)) {
      return { ok: false, reason: "labelIds must be an array of UUIDs" };
    }
    value.labelIds = [...parsed.labelIds];
  }

  if (parsed.kindLabelIds !== undefined) {
    const kinds = parsed.kindLabelIds;
    if (!isPlainObject(kinds)) return { ok: false, reason: "kindLabelIds must be an object" };
    for (const [kind, id] of Object.entries(kinds)) {
      if (!(KINDS as readonly string[]).includes(kind)) {
        return { ok: false, reason: "kindLabelIds has an unknown kind" };
      }
      if (!isUuid(id)) return { ok: false, reason: "kindLabelIds values must be UUIDs" };
      value.kindLabelIds[kind as Kind] = id;
    }
  }

  return { ok: true, value };
}
