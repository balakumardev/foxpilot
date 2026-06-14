import { buildHello } from "../hello";
import { getMessageSignature } from "../auth";

describe("buildHello", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: {
        secret: "shared",
        ports: [8089],
        browserId: "bid-1",
        browserLabel: "My Chrome",
      },
    });
    (browser as any).runtime.getBrowserInfo = undefined; // chrome
  });

  it("builds a signed hello envelope with the correct payload shape", async () => {
    const env = await buildHello("shared");
    const parsed = JSON.parse(env);
    expect(parsed.payload).toEqual({
      type: "hello",
      browserId: "bid-1",
      browserType: "chrome",
      label: "My Chrome",
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
});
