import { getOrCreateBrowserId, getBrowserType, getBrowserLabel } from "./extension-config";
import { getMessageSignature } from "./auth";

export interface HelloPayload {
  type: "hello";
  browserId: string;
  browserType: "chrome" | "firefox";
  label: string;
}

/**
 * Assembles and signs the connect-time hello envelope. Both transports send
 * this as their first frame/identity so the broker can verify the secret and
 * register the browser before admitting it. The signature is computed exactly
 * like every other extension->broker frame (HMAC-SHA256 over JSON(payload)).
 */
export async function buildHello(secret: string): Promise<string> {
  const payload: HelloPayload = {
    type: "hello",
    browserId: await getOrCreateBrowserId(),
    browserType: await getBrowserType(),
    label: await getBrowserLabel(),
  };
  const signature = await getMessageSignature(JSON.stringify(payload), secret);
  return JSON.stringify({ payload, signature });
}
