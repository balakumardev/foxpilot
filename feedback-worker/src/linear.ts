import { LINEAR_GRAPHQL_URL, LINEAR_TIMEOUT_MS, isTicketRef } from "./config";
import type { IssueInput } from "./format";

const ISSUE_CREATE = `mutation FoxPilotFeedbackIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { identifier }
  }
}`;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface Detail {
  status: number;
  code?: string;
  message?: string;
  /** Class of the exception fetch threw (for example TypeError); never its message. */
  errorName?: string;
}

/**
 * created:  Linear confirmed the issue.
 * rejected: Linear answered and refused, so nothing was filed.
 * unknown:  no usable answer (timeout, network error, 5xx); the issue may exist.
 */
export type LinearOutcome =
  | ({ kind: "created"; ref: string | null } & Detail)
  | ({ kind: "rejected" } & Detail)
  | ({ kind: "unknown" } & Detail);

interface LinearResponse {
  data?: {
    issueCreate?: { success?: boolean; issue?: { identifier?: unknown } | null } | null;
  } | null;
  errors?: { message?: unknown; extensions?: { code?: unknown } }[];
}

// Linear's error codes are short upper-case identifiers. Anything else is dropped: the code ends up
// in the logs, and a free-text error message can echo the submitted report back.
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

function safeCode(v: unknown): string | undefined {
  return typeof v === "string" && SAFE_CODE.test(v) ? v : undefined;
}

export async function createLinearIssue(
  apiKey: string,
  input: IssueInput,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = LINEAR_TIMEOUT_MS
): Promise<LinearOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(LINEAR_GRAPHQL_URL, {
        method: "POST",
        // Linear personal API keys go in the header as-is, without a "Bearer " prefix.
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ query: ISSUE_CREATE, variables: { input } }),
        signal: controller.signal,
        // Workers' fetch does not implement redirect:"error" (it throws a TypeError), so redirects are
        // never followed ("manual") and a 3xx answer is refused below. Following one would resend the
        // Authorization header to whatever host the answer names.
        redirect: "manual",
      });
    } catch (err) {
      const timedOut = controller.signal.aborted;
      return {
        kind: "unknown",
        status: 0,
        message: timedOut ? "timeout" : "network error",
        ...(timedOut ? {} : { errorName: err instanceof Error ? err.name : typeof err }),
      };
    }

    if (res.status >= 300 && res.status < 400) {
      // Not followed, and Linear has not processed the request, so nothing was filed.
      return { kind: "rejected", status: res.status, message: "unexpected redirect" };
    }

    let json: LinearResponse | null = null;
    try {
      json = (await res.json()) as LinearResponse | null;
    } catch {
      // Not JSON; handled below by status.
    }
    const err = json?.errors?.[0];
    // Linear's own error message is deliberately not kept (see SAFE_CODE); status and code are enough to debug.
    const detail: Detail = {
      status: res.status,
      code: safeCode(err?.extensions?.code),
    };

    if (json?.data?.issueCreate?.success === true) {
      const identifier = json.data.issueCreate.issue?.identifier;
      return { kind: "created", ref: isTicketRef(identifier) ? identifier : null, ...detail };
    }
    if (res.status >= 500 || controller.signal.aborted || (res.ok && !json)) {
      return { kind: "unknown", ...detail, message: detail.message ?? "no usable answer" };
    }
    return { kind: "rejected", ...detail, message: detail.message ?? "issueCreate returned no issue" };
  } finally {
    clearTimeout(timer);
  }
}
