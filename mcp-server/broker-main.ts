/**
 * Broker daemon entry point.
 *
 * This is the process spawned (detached) by the first MCP-client session when
 * no broker is already listening. It outlives individual client sessions and
 * shuts itself down once idle.
 */

import * as fs from "fs";
import { BrokerServer } from "./broker";
import { BrokerLongPoll } from "./broker-longpoll";
import { getControlSecret } from "./control-secret";

const WS_DEFAULT_PORT = 8089;
/** Mirrors browser-api.ts's BROKER_LOG_MAX_BYTES; see startLogTrimmer. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_CHECK_INTERVAL_MS = 60000;

/**
 * Bounds the log file this process is writing into.
 *
 * browser-api.ts caps the file when it opens it, but that only rotates at
 * SPAWN. This broker deliberately outlives individual client sessions, so a
 * chatty failure mode — the late/unknown-reply diagnostics firing on every MV3
 * service-worker flap, say — could grow the file without limit inside a single
 * lifetime. This is the other half of that bound.
 *
 * Trims through fd 1 rather than a path: fd 1 IS the log, because browser-api
 * redirected both our streams into it. That needs no filename shared across the
 * two files and makes it impossible to truncate the wrong file. The fd was
 * opened O_APPEND, so writes resume at offset 0 after the truncate instead of
 * leaving a sparse hole.
 *
 * isFile() is the gate that makes this safe everywhere else: with no log fd
 * stdout is /dev/null, and for a developer running the broker by hand it is a
 * TTY or a pipe — none of those are trimmable, and all of them are skipped.
 */
function startLogTrimmer(): void {
  const timer = setInterval(() => {
    try {
      const stat = fs.fstatSync(1);
      if (stat.isFile() && stat.size >= LOG_MAX_BYTES) {
        fs.ftruncateSync(1, 0);
        console.error(
          `Broker: log passed ${LOG_MAX_BYTES} bytes; truncated in place.`
        );
      }
    } catch {
      /* Log upkeep must never be the thing that takes the broker down. */
    }
  }, LOG_CHECK_INTERVAL_MS);
  // Never let log maintenance alone hold the process open.
  timer.unref?.();
}

/** Treats unset/""/"0"/"false" as false so `CONTAINERIZED=0` doesn't enable remote mode. */
function envFlag(value: string | undefined): boolean {
  return (
    value !== undefined &&
    value !== "" &&
    value !== "0" &&
    value.toLowerCase() !== "false"
  );
}

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
    requireSignature: envFlag(process.env.CONTAINERIZED),
    strictExtensionIds: strict.length > 0 ? strict : undefined,
  };
}

async function main() {
  startLogTrimmer();
  const { secret, port, requireSignature, strictExtensionIds } =
    readBrokerConfig();

  const host = envFlag(process.env.CONTAINERIZED) ? "0.0.0.0" : "localhost";
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
