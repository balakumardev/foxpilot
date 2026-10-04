import { describe, it, expect, vi } from "vitest";
import { handleRelayRequest, type RelayEnv } from "../src/route";
import {
  HEALTH_PATH,
  RELAY_PROTOCOL_VERSION,
} from "../../mcp-server/relay-protocol";

const VALID_ROOM = "testroom_01234567890123456789";

function createFakeEnv(options?: {
  rateLimitSuccess?: boolean;
  onDoFetch?: (req: Request) => Promise<Response>;
}): RelayEnv {
  const rateLimitSuccess = options?.rateLimitSuccess ?? true;
  return {
    CONNECT_LIMITER: {
      limit: vi.fn(async ({ key }: { key: string }) => ({
        success: rateLimitSuccess,
      })),
    },
    ROOMS: {
      idFromName: vi.fn((name: string) => `id:${name}`),
      get: vi.fn((id: unknown) => ({
        fetch: vi.fn(async (req: Request) => {
          if (options?.onDoFetch) {
            return options.onDoFetch(req);
          }
          return new Response(null, { status: 200 });
        }),
      })),
    },
  };
}

describe("route.ts handleRelayRequest", () => {
  it("serves health on /v1/health and /", async () => {
    const env = createFakeEnv();

    for (const path of [HEALTH_PATH, "/"]) {
      const req = new Request(`http://localhost${path}`, { method: "GET" });
      const res = await handleRelayRequest(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      const json = await res.json();
      expect(json).toEqual({
        ok: true,
        service: "foxpilot-relay",
        protocol: RELAY_PROTOCOL_VERSION,
      });
    }
  });

  it("returns 405 on non-GET methods on any path", async () => {
    const env = createFakeEnv();
    const cases = [
      { method: "POST", path: HEALTH_PATH },
      { method: "PUT", path: "/" },
      { method: "POST", path: `/v1/rooms/${VALID_ROOM}/host` },
      { method: "DELETE", path: "/unknown" },
    ];

    for (const { method, path } of cases) {
      const req = new Request(`http://localhost${path}`, { method });
      const res = await handleRelayRequest(req, env);
      expect(res.status).toBe(405);
      expect(await res.text()).toContain("Method not allowed");
    }
  });

  it("returns 404 on unknown paths and invalid room ids", async () => {
    const env = createFakeEnv();
    const paths = [
      "/whatever",
      "/v1/rooms",
      "/v1/rooms/invalid!/host",
      "/v1/rooms/short/host",
      `/v1/rooms/${VALID_ROOM}/other`,
    ];

    for (const path of paths) {
      const req = new Request(`http://localhost${path}`, {
        method: "GET",
        headers: { Upgrade: "websocket" },
      });
      const res = await handleRelayRequest(req, env);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not found");
    }
  });

  it("returns 426 when room path is missing Upgrade: websocket", async () => {
    const env = createFakeEnv();

    const noUpgradeReq = new Request(
      `http://localhost/v1/rooms/${VALID_ROOM}/host`,
      { method: "GET" }
    );
    const noUpgradeRes = await handleRelayRequest(noUpgradeReq, env);
    expect(noUpgradeRes.status).toBe(426);
    expect(await noUpgradeRes.text()).toBe("Expected a WebSocket upgrade");

    const badUpgradeReq = new Request(
      `http://localhost/v1/rooms/${VALID_ROOM}/client`,
      {
        method: "GET",
        headers: { Upgrade: "other" },
      }
    );
    const badUpgradeRes = await handleRelayRequest(badUpgradeReq, env);
    expect(badUpgradeRes.status).toBe(426);
    expect(await badUpgradeRes.text()).toBe("Expected a WebSocket upgrade");
  });

  it("returns 429 with Retry-After when rate limit is exceeded", async () => {
    const env = createFakeEnv({ rateLimitSuccess: false });
    const req = new Request(`http://localhost/v1/rooms/${VALID_ROOM}/client`, {
      method: "GET",
      headers: {
        Upgrade: "websocket",
        "CF-Connecting-IP": "203.0.113.1",
      },
    });

    const res = await handleRelayRequest(req, env);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(env.CONNECT_LIMITER!.limit).toHaveBeenCalledWith({
      key: "203.0.113.1",
    });
  });

  it("uses 'unknown' as rate limit key when CF-Connecting-IP is missing", async () => {
    const env = createFakeEnv({ rateLimitSuccess: false });
    const req = new Request(`http://localhost/v1/rooms/${VALID_ROOM}/client`, {
      method: "GET",
      headers: { Upgrade: "websocket" },
    });

    await handleRelayRequest(req, env);
    expect(env.CONNECT_LIMITER!.limit).toHaveBeenCalledWith({
      key: "unknown",
    });
  });

  it("strips incoming X-Relay-Role and sets verified role before forwarding to DO", async () => {
    let capturedReq: Request | null = null;
    const env = createFakeEnv({
      onDoFetch: async (req) => {
        capturedReq = req;
        return new Response(null, { status: 200 });
      },
    });

    const clientReq = new Request(
      `http://localhost/v1/rooms/${VALID_ROOM}/client`,
      {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          "X-Relay-Role": "host", // Malicious client claiming to be host
          "X-Custom-Header": "keep-me",
        },
      }
    );

    const res = await handleRelayRequest(clientReq, env);
    expect(res.status).toBe(200);
    expect(env.ROOMS.idFromName).toHaveBeenCalledWith(VALID_ROOM);
    expect(capturedReq).not.toBeNull();
    expect(capturedReq!.headers.get("X-Relay-Role")).toBe("client");
    expect(capturedReq!.headers.get("X-Custom-Header")).toBe("keep-me");
    expect(capturedReq!.headers.get("Upgrade")).toBe("websocket");

    // Also test host path
    const hostReq = new Request(
      `http://localhost/v1/rooms/${VALID_ROOM}/host`,
      {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          "X-Relay-Role": "client", // Claiming to be client on host path
        },
      }
    );

    await handleRelayRequest(hostReq, env);
    expect(capturedReq!.headers.get("X-Relay-Role")).toBe("host");
  });
});
