import {
  HEALTH_PATH,
  RELAY_PROTOCOL_VERSION,
  parseRoomPath,
} from "../../mcp-server/relay-protocol";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface RelayEnv {
  CONNECT_LIMITER?: RateLimiter;
  ROOMS: DurableObjectNamespaceLike;
}

export async function handleRelayRequest(
  request: Request,
  env: RelayEnv
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/" || pathname === HEALTH_PATH) {
    return new Response(
      JSON.stringify({
        ok: true,
        service: "foxpilot-relay",
        protocol: RELAY_PROTOCOL_VERSION,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const parsed = parseRoomPath(pathname);
  if (!parsed) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const upgrade = request.headers.get("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", {
      status: 426,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (env.CONNECT_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.CONNECT_LIMITER.limit({ key: ip });
    if (!success) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: {
          "Content-Type": "text/plain",
          "Retry-After": "60",
        },
      });
    }
  }

  const doId = env.ROOMS.idFromName(parsed.roomId);
  const stub = env.ROOMS.get(doId);

  const headers = new Headers(request.headers);
  headers.delete("X-Relay-Role");
  headers.set("X-Relay-Role", parsed.role);

  const forwardReq = new Request(request, {
    method: "GET",
    headers,
  });

  return stub.fetch(forwardReq);
}
