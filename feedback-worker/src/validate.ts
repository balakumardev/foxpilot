import {
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  KINDS,
  META_MAX,
  TITLE_MAX,
  TITLE_MIN,
  type Kind,
} from "./config";
import { cleanLine, cleanText } from "./sanitize";

const META_FIELDS = [
  "tool",
  "foxpilotVersion",
  "clientName",
  "clientVersion",
  "platform",
  "nodeVersion",
] as const;

export interface Feedback {
  title: string;
  description: string;
  kind: Kind;
  tool?: string;
  foxpilotVersion?: string;
  clientName?: string;
  clientVersion?: string;
  platform?: string;
  nodeVersion?: string;
}

export type Validation = { ok: true; value: Feedback } | { ok: false; error: string };

const ALLOWED = new Set<string>(["title", "description", "kind", ...META_FIELDS]);

function fail(error: string): Validation {
  return { ok: false, error };
}

export function validateFeedback(input: unknown): Validation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("body must be a JSON object");
  }
  const body = input as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) {
      return fail(
        `unknown field "${cleanLine(key).slice(0, 40)}"; allowed: ${[...ALLOWED].join(", ")}`
      );
    }
  }

  if (typeof body.title !== "string") return fail("title is required and must be a string");
  const title = cleanLine(body.title);
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    return fail(`title must be ${TITLE_MIN}-${TITLE_MAX} characters`);
  }

  if (typeof body.description !== "string") {
    return fail("description is required and must be a string");
  }
  const description = cleanText(body.description);
  if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    return fail(`description must be ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} characters`);
  }

  const kind = body.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    return fail(`kind must be one of: ${KINDS.join(", ")}`);
  }

  const value: Feedback = { title, description, kind: kind as Kind };
  for (const field of META_FIELDS) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (typeof raw !== "string") return fail(`${field} must be a string`);
    const clean = cleanLine(raw);
    if (clean.length > META_MAX) return fail(`${field} must be at most ${META_MAX} characters`);
    if (clean) value[field] = clean;
  }
  return { ok: true, value };
}
