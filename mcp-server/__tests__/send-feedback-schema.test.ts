import * as fs from "fs";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  SEND_FEEDBACK_ANNOTATIONS,
  SEND_FEEDBACK_DESCRIPTION,
  sendFeedbackInputShape,
} from "../feedback-client";

// server.ts self-executes on import, so this registers the tool the way
// server.ts does (same name, description, shape and annotations, all imported
// from feedback-client) on a throwaway McpServer and talks to it through the
// SDK's own validation. A source check below ties server.ts to those exports.

const handler = jest.fn(async (_args: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: "ok" }],
}));

let client: Client;
let server: McpServer;

beforeEach(async () => {
  handler.mockClear();
  server = new McpServer({ name: "FoxPilot", version: "0.0.0-test" });
  server.tool(
    "send-feedback",
    SEND_FEEDBACK_DESCRIPTION,
    sendFeedbackInputShape,
    SEND_FEEDBACK_ANNOTATIONS,
    async (args) => handler(args)
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.2.3" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
});

const valid = {
  kind: "bug",
  title: "click-element reports success but nothing happens",
  description: "I called click-element on a menu item and it answered Clicked element e2, but the menu did not open.",
  userApproved: true,
};

async function call(args: Record<string, unknown>): Promise<{ failed: boolean }> {
  try {
    const r = await client.callTool({ name: "send-feedback", arguments: args });
    return { failed: r.isError === true };
  } catch {
    return { failed: true };
  }
}

describe("send-feedback input schema", () => {
  it("accepts a complete, approved report", async () => {
    expect(await call(valid)).toEqual({ failed: false });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ kind: "bug", userApproved: true });
  });

  it("accepts the optional tool", async () => {
    expect(await call({ ...valid, tool: "click-element" })).toEqual({ failed: false });
    expect(handler.mock.calls[0][0]).toMatchObject({ tool: "click-element" });
  });

  it.each([
    ["userApproved: false", { ...valid, userApproved: false }],
    ["userApproved missing", (({ userApproved: _u, ...rest }) => rest)(valid)],
    ["userApproved as a string", { ...valid, userApproved: "true" }],
    ["userApproved as 1", { ...valid, userApproved: 1 }],
    ["userApproved null", { ...valid, userApproved: null }],
  ])("rejects %s and never runs the handler", async (_name, args) => {
    expect((await call(args as Record<string, unknown>)).failed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown kind", { ...valid, kind: "complaint" }],
    ["missing kind", { ...valid, kind: undefined }],
    ["title under 3 characters", { ...valid, title: "ab" }],
    ["title over 140 characters", { ...valid, title: "t".repeat(141) }],
    ["description under 10 characters", { ...valid, description: "too short" }],
    ["description over 8000 characters", { ...valid, description: "d".repeat(8001) }],
    ["tool over 64 characters", { ...valid, tool: "x".repeat(65) }],
    ["title not a string", { ...valid, title: 42 }],
  ])("rejects %s", async (_name, args) => {
    expect((await call(args as Record<string, unknown>)).failed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts the limits themselves", async () => {
    expect(
      (await call({ ...valid, title: "t".repeat(140), description: "d".repeat(8000), tool: "x".repeat(64) })).failed
    ).toBe(false);
    expect((await call({ ...valid, title: "abc", description: "d".repeat(10) })).failed).toBe(false);
  });
});

describe("send-feedback tool listing", () => {
  async function listed() {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "send-feedback");
    if (!tool) throw new Error("send-feedback is not listed");
    return tool;
  }

  it("lists the four required fields and leaves tool optional", async () => {
    const tool = await listed();
    expect([...(tool.inputSchema.required ?? [])].sort()).toEqual(["description", "kind", "title", "userApproved"]);
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual([
      "description", "kind", "title", "tool", "userApproved",
    ]);
    const kind = tool.inputSchema.properties?.kind as { enum?: string[] };
    expect(kind.enum).toEqual(["bug", "feature", "improvement", "other"]);
  });

  it("describes userApproved as consent to send this exact report", async () => {
    const tool = await listed();
    const approved = tool.inputSchema.properties?.userApproved as { description?: string };
    expect(approved.description).toBe("Set true only after the user has agreed to send this exact report");
  });

  it("carries the annotations", async () => {
    const tool = await listed();
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("tells the model when to send and what never to include", async () => {
    const { description } = await listed();
    expect(description).toMatch(/only when the user asks you to report something or agrees/i);
    expect(description).toMatch(/generically/i);
    for (const forbidden of ["page content", "URLs", "tab titles", "cookies", "credentials", "link tokens", "personal data"]) {
      expect(description).toContain(forbidden);
    }
    expect(description).toMatch(/NEVER include/);
    expect(description).toMatch(/over the internet/);
    expect(description).toContain("FOXPILOT_FEEDBACK=off");
  });
});

describe("send-feedback wiring", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.ts"), "utf8");

  it("server.ts registers the tool with the shared description, shape and annotations", () => {
    expect(serverSource).toMatch(
      /mcpServer\.tool\(\s*"send-feedback",\s*SEND_FEEDBACK_DESCRIPTION,\s*sendFeedbackInputShape,\s*SEND_FEEDBACK_ANNOTATIONS,/
    );
  });

  it("the handler leaves userApproved out of what it forwards", () => {
    const start = serverSource.indexOf('"send-feedback"');
    const block = serverSource.slice(start, serverSource.indexOf("\n);\n", start));
    expect(block).toMatch(/async \(\{ kind, title, description, tool \}, extra\)/);
    expect(block).toMatch(/submitFeedback\(\s*\{ kind, title, description, tool \}/);
    // Only the comment mentions it; no code reads or forwards it.
    const code = block.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toContain("userApproved");
  });

  it("the handler takes the metadata from the process and the connected client, never the model", () => {
    const start = serverSource.indexOf('"send-feedback"');
    const block = serverSource.slice(start, serverSource.indexOf("\n);\n", start));
    expect(block).toContain("mcpServer.server.getClientVersion()");
    expect(block).toContain("foxpilotVersion: FOXPILOT_VERSION");
    expect(block).toContain("platform: `${process.platform}-${process.arch}`");
    expect(block).toContain("nodeVersion: process.version");
  });

  it("does not touch the browser or broker", () => {
    const start = serverSource.indexOf('"send-feedback"');
    const block = serverSource.slice(start, serverSource.indexOf("\n);\n", start));
    expect(block).not.toContain("browserApi");
  });

  it("the DXT manifest lists the tool", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")) as {
      tools: Array<{ name: string; description: string }>;
    };
    const entry = manifest.tools.find((t) => t.name === "send-feedback");
    expect(entry).toBeDefined();
    expect(entry?.description).toMatch(/FOXPILOT_FEEDBACK=off/);
    expect(new Set(manifest.tools.map((t) => t.name)).size).toBe(manifest.tools.length);
  });
});
