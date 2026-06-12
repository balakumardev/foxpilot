/**
 * HMAC-SHA256 message signing shared by the broker and the broker client.
 *
 * The signature is computed over the JSON string of the payload, matching the
 * extension's Web Crypto implementation (`firefox-extension/auth.ts`) so the
 * broker <-> extension leg interoperates with existing extension code.
 */

import * as crypto from "crypto";

export function createSignature(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifySignature(
  secret: string,
  payload: string,
  signature: string
): boolean {
  if (typeof signature !== "string" || signature.length === 0) {
    return false;
  }
  const expected = createSignature(secret, payload);
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
