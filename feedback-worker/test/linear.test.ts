import { describe, expect, it, vi } from "vitest";
import { createLinearIssue } from "../src/linear";
import type { IssueInput } from "../src/format";
import { fakeFetch, linearOk, TEAM_ID } from "./fakes";

const input: IssueInput = { teamId: TEAM_ID, title: "[FoxPilot feedback] x", description: "body" };
const API_KEY = "lin_api_TESTKEY_0123456789abcdef";

describe("createLinearIssue", () => {
  it("posts the mutation to Linear's GraphQL endpoint with the raw key", async () => {
    const fetchImpl = fakeFetch();
    await createLinearIssue(API_KEY, input, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: API_KEY, "Content-Type": "application/json" });
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain("issueCreate(input: $input)");
    expect(body.query).toContain("issue { identifier }");
    expect(body.variables).toEqual({ input });
  });

  describe("created", () => {
    it("returns the issue identifier", async () => {
      expect(await createLinearIssue(API_KEY, input, fakeFetch(() => linearOk("FP-12")))).toEqual({
        kind: "created",
        ref: "FP-12",
        status: 200,
        code: undefined,
        message: undefined,
      });
    });

    it.each(["fp-12", "<script>", "FP-0", "FP-12 extra", 12, null, undefined])(
      "returns no ref for an unusable identifier: %j",
      async (identifier) => {
        const fetchImpl = fakeFetch(() =>
          Response.json({ data: { issueCreate: { success: true, issue: { identifier } } } })
        );
        expect(await createLinearIssue(API_KEY, input, fetchImpl)).toMatchObject({ kind: "created", ref: null });
      }
    );

    it("returns no ref when Linear reports success without an issue", async () => {
      const fetchImpl = fakeFetch(() => Response.json({ data: { issueCreate: { success: true, issue: null } } }));
      expect(await createLinearIssue(API_KEY, input, fetchImpl)).toMatchObject({ kind: "created", ref: null });
    });
  });

  describe("rejected", () => {
    it("reports a GraphQL error with its code and a fixed message", async () => {
      const fetchImpl = fakeFetch(() =>
        Response.json({ errors: [{ message: "Argument Validation Error", extensions: { code: "INVALID_INPUT" } }] })
      );
      expect(await createLinearIssue(API_KEY, input, fetchImpl)).toEqual({
        kind: "rejected",
        status: 200,
        code: "INVALID_INPUT",
        message: "issueCreate returned no issue",
      });
    });

    it.each([400, 401, 403, 404, 429])("treats HTTP %i as a refusal", async (status) => {
      const fetchImpl = fakeFetch(() => Response.json({ errors: [{ message: "nope" }] }, { status }));
      expect(await createLinearIssue(API_KEY, input, fetchImpl)).toMatchObject({ kind: "rejected", status, message: "issueCreate returned no issue" });
    });

    it("treats a non-JSON 4xx as a refusal", async () => {
      const fetchImpl = fakeFetch(() => new Response("Forbidden", { status: 403 }));
      expect(await createLinearIssue(API_KEY, input, fetchImpl)).toEqual({
        kind: "rejected",
        status: 403,
        code: undefined,
        message: "issueCreate returned no issue",
      });
    });

    it("treats success:false as a refusal", async () => {
      const fetchImpl = fakeFetch(() => Response.json({ data: { issueCreate: { success: false, issue: null } } }));
      expect(await createLinearIssue(API_KEY, input, fetchImpl)).toMatchObject({
        kind: "rejected",
        status: 200,
        message: "issueCreate returned no issue",
      });
    });

    it("never keeps Linear's free-text message, because it can echo the report", async () => {
      const echoed = "Argument Validation Error: title 'my secret report text' is too long";
      const fetchImpl = fakeFetch(() =>
        Response.json({ errors: [{ message: echoed, extensions: { code: "INVALID_INPUT" } }] }, { status: 400 })
      );
      const outcome = await createLinearIssue(API_KEY, input, fetchImpl);
      expect(JSON.stringify(outcome)).not.toContain("secret report text");
      expect(outcome).toEqual({
        kind: "rejected",
        status: 400,
        code: "INVALID_INPUT",
        message: "issueCreate returned no issue",
      });
    });

    it("drops an error code that is not a short identifier", async () => {
      for (const code of ["c".repeat(65), "has spaces in it", "report text: <b>hi</b>", ""]) {
        const fetchImpl = fakeFetch(() =>
          Response.json({ errors: [{ message: "x", extensions: { code } }] }, { status: 400 })
        );
        const outcome = await createLinearIssue(API_KEY, input, fetchImpl);
        expect(outcome.kind === "rejected" && outcome.code).toBeUndefined();
      }
    });

    it("ignores error fields that are not strings", async () => {
      const fetchImpl = fakeFetch(() =>
        Response.json({ errors: [{ message: { a: 1 }, extensions: { code: 5 } }] }, { status: 400 })
      );
      expect(await createLinearIssue(API_KEY, input, fetchImpl)).toEqual({
        kind: "rejected",
        status: 400,
        code: undefined,
        message: "issueCreate returned no issue",
      });
    });
  });

  describe("unknown", () => {
    it("reports a network error", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError("fetch failed");
      });
      expect(await createLinearIssue(API_KEY, input, fetchImpl)).toEqual({
        kind: "unknown",
        status: 0,
        message: "network error",
        errorName: "TypeError",
      });
    });

    it("refuses a redirect without following it, so the key is never sent to another host", async () => {
      const fetchImpl = vi.fn(
        async (_url: string, _init: RequestInit) =>
          new Response(null, { status: 302, headers: { Location: "https://evil.example/" } })
      );
      expect(await createLinearIssue(API_KEY, input, fetchImpl)).toEqual({
        kind: "rejected",
        status: 302,
        message: "unexpected redirect",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("gives up after the timeout and aborts the request", async () => {
      let aborted = false;
      const fetchImpl = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          })
      );
      const started = Date.now();
      const outcome = await createLinearIssue(API_KEY, input, fetchImpl, 30);
      expect(outcome).toEqual({ kind: "unknown", status: 0, message: "timeout" });
      expect(aborted).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("gives up when the body stalls after the headers", async () => {
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        const stream = new ReadableStream({
          start(controller) {
            init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
          },
        });
        return new Response(stream, { status: 200 });
      });
      expect(await createLinearIssue(API_KEY, input, fetchImpl, 30)).toMatchObject({ kind: "unknown", message: "no usable answer" });
    });

    it.each([500, 502, 503, 504])("treats HTTP %i as unknown, even with an error body", async (status) => {
      const fetchImpl = fakeFetch(() => Response.json({ errors: [{ message: "upstream" }] }, { status }));
      expect(await createLinearIssue(API_KEY, input, fetchImpl)).toMatchObject({ kind: "unknown", status, message: "no usable answer" });
    });

    it("treats a 5xx without a body as unknown", async () => {
      const fetchImpl = fakeFetch(() => new Response("Bad Gateway", { status: 502 }));
      expect(await createLinearIssue(API_KEY, input, fetchImpl)).toEqual({
        kind: "unknown",
        status: 502,
        code: undefined,
        message: "no usable answer",
      });
    });

    it("treats a 200 that is not JSON as unknown, because the issue may have been created", async () => {
      const fetchImpl = fakeFetch(() => new Response("<html>ok</html>", { status: 200 }));
      expect(await createLinearIssue(API_KEY, input, fetchImpl)).toMatchObject({
        kind: "unknown",
        status: 200,
        message: "no usable answer",
      });
    });
  });

  it("clears its timer, so a fast answer does not leave one pending", async () => {
    vi.useFakeTimers();
    try {
      await createLinearIssue(API_KEY, input, fakeFetch());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
