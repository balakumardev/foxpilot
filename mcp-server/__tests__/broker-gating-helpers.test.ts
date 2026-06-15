import { parseExtensionOrigin, isLoopbackAddress } from "../broker";

describe("parseExtensionOrigin", () => {
  it("accepts chrome/moz extension origins and returns the id", () => {
    expect(parseExtensionOrigin("chrome-extension://abcID")).toBe("abcID");
    expect(parseExtensionOrigin("moz-extension://xyz")).toBe("xyz");
    expect(parseExtensionOrigin("CHROME-EXTENSION://Up")).toBe("Up");
    expect(parseExtensionOrigin("chrome-extension://id/")).toBe("id");
  });

  it("rejects webpage / malformed / missing origins", () => {
    const bad = [
      undefined,
      "",
      "null",
      "https://evil.com",
      "https://chrome-extension://x",
      "data:chrome-extension://x",
      "chrome-extensionX://x",
      "chrome-extension://id\nhttps://evil",
      "chrome-extension://id/../../x",
    ];
    for (const b of bad) {
      expect(parseExtensionOrigin(b as unknown as string)).toBeNull();
    }
  });
});

describe("isLoopbackAddress", () => {
  it("accepts loopback forms", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::ffff:127.5.5.5"]) {
      expect(isLoopbackAddress(a)).toBe(true);
    }
  });

  it("rejects non-loopback / empty", () => {
    for (const a of [undefined, "", "0.0.0.0", "::", "192.168.1.5", "10.0.0.1", "169.254.1.1"]) {
      expect(isLoopbackAddress(a as unknown as string)).toBe(false);
    }
  });
});
