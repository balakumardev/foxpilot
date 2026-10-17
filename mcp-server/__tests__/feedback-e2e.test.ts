import * as http from "http";
import { AddressInfo } from "net";
import { sendFeedback, submitFeedback } from "../feedback-client";
import { FOXPILOT_VERSION } from "../version";

// send-feedback against a real HTTP server on 127.0.0.1, reached through the
// FOXPILOT_FEEDBACK_URL override and the real global fetch.

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void;

const servers: http.Server[] = [];

async function listen(handler: Handler): Promise<{ url: string; seen: Seen[]; server: http.Server }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1/feedback`, seen, server };
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        })
    )
  );
});

const input = {
  kind: "bug" as const,
  title: "fill-element leaves a React input empty",
  description: "fill-element answered Filled but the controlled input still showed its old value afterwards.",
  tool: "fill-element",
};

describe("send-feedback end to end over HTTP", () => {
  it("delivers the exact JSON the server expects and reports the ref", async () => {
    const { url, seen } = await listen((_req, res) => json(res, 201, { ok: true, ref: "PER-321" }));

    const out = await submitFeedback(
      { ...input, description: input.description + " My address is bob@example.com and the page was https://shop.example.com/cart?session=abc123." },
      {
        env: { FOXPILOT_FEEDBACK_URL: url },
        metadata: {
          foxpilotVersion: FOXPILOT_VERSION,
          clientName: "test-client",
          clientVersion: "9.9.9",
          platform: "testos-x64",
          nodeVersion: "v22.0.0",
        },
      }
    );

    expect(out.isError).toBe(false);
    expect(out.text).toContain("PER-321");
    expect(out.text).toMatch(/2 values .* were redacted/);

    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/v1/feedback");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["user-agent"]).toBe(`foxpilot-mcp/${FOXPILOT_VERSION}`);
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers.authorization).toBeUndefined();
    expect(JSON.parse(req.body)).toEqual({
      kind: "bug",
      title: "fill-element leaves a React input empty",
      description:
        "fill-element answered Filled but the controlled input still showed its old value afterwards. My address is [email] and the page was https://shop.example.com/cart?[redacted].",
      tool: "fill-element",
      foxpilotVersion: FOXPILOT_VERSION,
      clientName: "test-client",
      clientVersion: "9.9.9",
      platform: "testos-x64",
      nodeVersion: "v22.0.0",
    });
    expect(req.body).not.toContain("userApproved");
    expect(req.body).not.toContain("bob@example.com");
    expect(req.body).not.toContain("abc123");
  });

  it("a duplicate reply is not an error", async () => {
    const { url } = await listen((_req, res) => json(res, 200, { ok: true, ref: "PER-1", duplicate: true }));
    const out = await submitFeedback(input, { env: { FOXPILOT_FEEDBACK_URL: url } });
    expect(out.isError).toBe(false);
    expect(out.result).toEqual({ kind: "duplicate", ref: "PER-1" });
  });

  it("reads the Retry-After header of a 429", async () => {
    const { url } = await listen((_req, res) => json(res, 429, { ok: false, error: "slow down" }, { "Retry-After": "90" }));
    const out = await submitFeedback(input, { env: { FOXPILOT_FEEDBACK_URL: url } });
    expect(out.result).toEqual({ kind: "rate-limited", retryAfterSeconds: 90, error: "slow down" });
    expect(out.text).toContain("2 minutes");
  });

  it("does not follow a redirect, so the report never reaches the other host", async () => {
    const target = await listen((_req, res) => json(res, 201, { ok: true, ref: "PER-X" }));
    const redirector = await listen((_req, res) => {
      res.writeHead(307, { Location: target.url });
      res.end();
    });
    const out = await submitFeedback(input, { env: { FOXPILOT_FEEDBACK_URL: redirector.url } });
    expect(out.isError).toBe(true);
    expect(out.result?.kind).toBe("network-error");
    expect(out.text).toMatch(/redirect/i);
    expect(redirector.seen).toHaveLength(1);
    expect(target.seen).toHaveLength(0);
  });

  it("times out on a server that never answers and says the report may exist", async () => {
    const { url, seen } = await listen(() => undefined);
    const started = Date.now();
    const out = await submitFeedback(input, { env: { FOXPILOT_FEEDBACK_URL: url }, timeoutMs: 150 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.result).toEqual({ kind: "unknown-outcome", reason: "timeout" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("may already have been filed");
    expect(seen).toHaveLength(1); // no retry
  });

  it("an oversized junk body is capped, not buffered", async () => {
    const { url } = await listen((_req, res) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      const chunk = Buffer.alloc(64 * 1024, 97);
      let sent = 0;
      const write = () => {
        while (sent < 200) {
          sent++;
          if (!res.write(chunk)) {
            res.once("drain", write);
            return;
          }
        }
        res.end();
      };
      write();
      res.on("error", () => undefined);
    });
    const r = await sendFeedback(
      { kind: "bug", title: "a title", description: "a description long enough" },
      { env: { FOXPILOT_FEEDBACK_URL: url } }
    );
    expect(r).toEqual({ kind: "rejected", status: 502, error: undefined });
  });

  it("reports a closed port as a network error that was not sent", async () => {
    const { url, server } = await listen(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const out = await submitFeedback(input, { env: { FOXPILOT_FEEDBACK_URL: url } });
    expect(out.isError).toBe(true);
    expect(out.result).toEqual({ kind: "network-error", error: "ECONNREFUSED" });
    expect(out.text).toContain("Not sent");
  });

  it("sends nothing when FOXPILOT_FEEDBACK=off, even with a working override", async () => {
    const { url, seen } = await listen((_req, res) => json(res, 201, { ok: true, ref: "PER-1" }));
    const out = await submitFeedback(input, { env: { FOXPILOT_FEEDBACK: "off", FOXPILOT_FEEDBACK_URL: url } });
    expect(out.result).toEqual({ kind: "disabled" });
    expect(seen).toHaveLength(0);
  });
});
