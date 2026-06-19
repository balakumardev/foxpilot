import { buildHello, HELLO_PROTOCOL_VERSION } from "../hello";
import { getMessageSignature } from "../auth";

describe("buildHello", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: {
        secret: "shared",
        ports: [8089],
        browserId: "bid-1",
        browserLabel: "My Firefox",
      },
    });
    // Firefox exposes runtime.getBrowserInfo (getBrowserType returns "firefox").
    (browser as any).runtime.getBrowserInfo = jest.fn();
  });

  it("builds a signed hello envelope with the correct payload shape", async () => {
    const env = await buildHello("shared");
    const parsed = JSON.parse(env);
    expect(parsed.payload).toEqual({
      type: "hello",
      browserId: "bid-1",
      browserType: "firefox",
      label: "My Firefox",
      protocolVersion: HELLO_PROTOCOL_VERSION,
    });
    const expectedSig = await getMessageSignature(
      JSON.stringify(parsed.payload),
      "shared"
    );
    expect(parsed.signature).toBe(expectedSig);
  });

  it("signs the payload with the provided secret", async () => {
    const env = await buildHello("shared");
    const parsed = JSON.parse(env);
    const wrongSig = await getMessageSignature(
      JSON.stringify(parsed.payload),
      "other-secret"
    );
    expect(parsed.signature).not.toBe(wrongSig);
  });

  it("omits the signature in origin mode (no secret configured)", async () => {
    const env = await buildHello("");
    const parsed = JSON.parse(env);
    // Same payload shape as signed mode...
    expect(parsed.payload).toEqual({
      type: "hello",
      browserId: "bid-1",
      browserType: "firefox",
      label: "My Firefox",
      protocolVersion: HELLO_PROTOCOL_VERSION,
    });
    // ...but NO signature field — the broker admits by Origin, and signing an
    // empty secret would throw (auth.getMessageSignature rejects "").
    expect("signature" in parsed).toBe(false);
    expect(parsed.signature).toBeUndefined();
  });
});
