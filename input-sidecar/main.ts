import { SidecarServer } from "./server";
import { NutInputBackend } from "./nut-backend";

const secret = process.env.EXTENSION_SECRET;
const port = process.env.SIDECAR_PORT ? parseInt(process.env.SIDECAR_PORT, 10) : 8090;
if (!secret) { console.error("EXTENSION_SECRET required"); process.exit(1); }

const server = new SidecarServer({ port, host: "127.0.0.1", secret: secret!, backend: new NutInputBackend() });
server.listen().then(() => console.error(`[input-sidecar] listening on ${port}`)).catch((e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") { process.exit(0); } // another sidecar won the race
  console.error(e); process.exit(1);
});
