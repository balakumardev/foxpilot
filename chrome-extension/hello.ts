import { getOrCreateBrowserId, getBrowserType, getBrowserLabel } from "./extension-config";
import { getMessageSignature } from "./auth";

export interface HelloPayload {
  type: "hello";
  browserId: string;
  browserType: "chrome" | "firefox";
  label: string;
}

/**
 * Assembles the connect-time hello envelope. Both transports send this as their
 * first frame/identity so the broker can register the browser before admitting
 * it.
 *
 * Two auth modes, decided by whether a secret is configured:
 *  - Origin mode (DEFAULT, no secret): emit an UNSIGNED `{ payload }` frame. The
 *    broker admits based on the `chrome-extension://` Origin the browser sets
 *    automatically. We must NOT call getMessageSignature here — it throws on an
 *    empty secret.
 *  - Signed mode (LEGACY/ADVANCED, a secret is set): sign the payload exactly
 *    like every other extension->broker frame (HMAC-SHA256 over JSON(payload))
 *    and emit `{ payload, signature }`.
 */
export async function buildHello(secret: string): Promise<string> {
  const payload: HelloPayload = {
    type: "hello",
    browserId: await getOrCreateBrowserId(),
    browserType: await getBrowserType(),
    label: await getBrowserLabel(),
  };
  if (!secret) {
    return JSON.stringify({ payload });
  }
  const signature = await getMessageSignature(JSON.stringify(payload), secret);
  return JSON.stringify({ payload, signature });
}
