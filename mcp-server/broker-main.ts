/**
 * Broker daemon entry point.
 *
 * This is the process spawned (detached) by the first MCP-client session when
 * no broker is already listening. It outlives individual client sessions and
 * shuts itself down once idle.
 */

import { BrokerServer } from "./broker";

const WS_DEFAULT_PORT = 8089;

function readBrokerConfig() {
  return {
    secret: process.env.EXTENSION_SECRET,
    port: process.env.EXTENSION_PORT
      ? parseInt(process.env.EXTENSION_PORT, 10)
      : WS_DEFAULT_PORT,
  };
}

async function main() {
  const { secret, port } = readBrokerConfig();
  if (!secret) {
    console.error(
      "Broker: EXTENSION_SECRET env var missing. See the extension's options page."
    );
    process.exit(1);
  }

  const host = process.env.CONTAINERIZED ? "0.0.0.0" : "localhost";
  const server = new BrokerServer({
    port,
    host,
    secret,
    onIdle: () => {
      console.error(
        "Broker: idle with no clients or extension; shutting down."
      );
      server.close();
      process.exit(0);
    },
  });

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
