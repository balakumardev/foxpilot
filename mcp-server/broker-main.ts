/**
 * Broker daemon entry point.
 *
 * This is the process spawned (detached) by the first MCP-client session when
 * no broker is already listening. It outlives individual client sessions and
 * shuts itself down once idle.
 */

import { BrokerServer } from "./broker";
import { BrokerLongPoll } from "./broker-longpoll";
import { getControlSecret } from "./control-secret";

const WS_DEFAULT_PORT = 8089;

function readBrokerConfig() {
  const strict = (process.env.FOXPILOT_STRICT_EXTENSION_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    secret: getControlSecret(),
    port: process.env.EXTENSION_PORT
      ? parseInt(process.env.EXTENSION_PORT, 10)
      : WS_DEFAULT_PORT,
    requireSignature: !!process.env.CONTAINERIZED,
    strictExtensionIds: strict.length > 0 ? strict : undefined,
  };
}

async function main() {
  const { secret, port, requireSignature, strictExtensionIds } =
    readBrokerConfig();

  const host = process.env.CONTAINERIZED ? "0.0.0.0" : "localhost";
  const server = new BrokerServer({
    port,
    host,
    secret,
    requireSignature,
    strictExtensionIds,
    onIdle: () => {
      console.error(
        "Broker: idle with no clients or extension; shutting down."
      );
      server.close();
      process.exit(0);
    },
  });

  // Enable the HTTP long-poll fallback transport for the extension leg.
  new BrokerLongPoll(server, secret);

  try {
    await server.listen();
    console.error(`Broker listening on ${host}:${port}`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      // Another broker won the start-up race; this process simply exits and
      // the spawning client connects to the broker that is already running.
      console.error(
        `Broker: port ${port} already in use; another broker is running. Exiting.`
      );
      process.exit(0);
    }
    console.error("Broker failed to start:", err);
    process.exit(1);
  }
}

main();
