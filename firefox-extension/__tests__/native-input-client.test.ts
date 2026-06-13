// The native-input client signs each request with the extension's Web Crypto
// HMAC signer. crypto.subtle is not available in this jsdom test env, so we mock
// ./auth to keep this test focused on correlation + lifecycle (the signature
// bytes are exercised end-to-end by the sidecar's own server.test.ts).
jest.mock("../auth", () => ({ getMessageSignature: async () => "sig" }));

import { NativeInputClient } from "../native-input-client";

class FakeWS {
  static instances: FakeWS[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  readyState = 0;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen && this.onopen();
  }
  receive(obj: unknown) {
    this.onmessage && this.onmessage({ data: JSON.stringify(obj) });
  }
}

describe("NativeInputClient", () => {
  beforeEach(() => {
    FakeWS.instances = [];
    (global as any).WebSocket = FakeWS as any;
  });

  it("signs and resolves a gesture by id", async () => {
    const client = new NativeInputClient(8090, "secret");
    const p = client.sendGesture({ kind: "probe" });
    const ws = FakeWS.instances[0];
    ws.open();
    // Let the post-connect microtasks (sign + send) flush before asserting.
    await Promise.resolve();
    await Promise.resolve();
    // The client should have sent one signed frame:
    expect(ws.sent.length).toBe(1);
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.payload.gesture.kind).toBe("probe");
    expect(typeof sent.signature).toBe("string");
    ws.receive({ payload: { id: sent.payload.id, ok: true }, signature: "x" });
    await expect(p).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it("resolves ok:false when the socket errors (caller will fall back)", async () => {
    const client = new NativeInputClient(8090, "secret");
    const p = client.sendGesture({ kind: "probe" });
    const ws = FakeWS.instances[0];
    ws.onerror && ws.onerror();
    await expect(p).resolves.toEqual(expect.objectContaining({ ok: false }));
  });
});
