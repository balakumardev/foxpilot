import * as crypto from "crypto";
import {
  ClientHandshake,
  LINK_CHUNK_CHARS,
  LINK_LABEL_MAX,
  LINK_MAX_PARTS,
  LinkProtocolError,
  SecureChannel,
  VerifiedHello,
  buildReject,
  buildWelcome,
  deriveRoomId,
  formatLinkToken,
  generateLinkSecret,
  isDataFrame,
  isHandshakeFrame,
  parseLinkToken,
  sanitizeLabel,
  sanitizeVersion,
  verifyHello,
} from "../link-crypto";
import { ROOM_ID_RE } from "../relay-protocol";

const b64 = (b: Buffer) => b.toString("base64url");

/** Replaces one char of a string with a different base64url char. */
function flipChar(text: string, at: number): string {
  const c = text[at];
  const replacement = c === "A" ? "B" : "A";
  return text.slice(0, at) + replacement + text.slice(at + 1);
}

/** Rewrites one field of an `H{...}` frame. */
function editFrame(frame: string, edit: (msg: Record<string, unknown>) => void): string {
  const msg = JSON.parse(frame.slice(1));
  edit(msg);
  return "H" + JSON.stringify(msg);
}

function handshake(secret = generateLinkSecret(), label = "cloud box", version = "1.2.3") {
  const client = new ClientHandshake(secret, { label, version });
  const check = verifyHello(secret, client.hello());
  if (!check.ok) throw new Error(`hello rejected: ${check.reason}`);
  const { welcome, channel: host } = buildWelcome(secret, check.hello, { version: "9.9.9" });
  const result = client.finish(welcome);
  if (result.kind !== "established") throw new Error("not established");
  return { secret, client: result.channel, host, peerVersion: result.peerVersion, hello: check.hello };
}

/** Delivers every frame of a sealed message, returning the final open() result. */
function deliver(to: SecureChannel, frames: string[]): string | null {
  let out: string | null = null;
  frames.forEach((f, i) => {
    out = to.open(f);
    if (i < frames.length - 1) expect(out).toBeNull();
  });
  return out;
}

describe("link token", () => {
  test("round-trips with and without a relay URL", () => {
    const secret = generateLinkSecret();
    expect(secret.length).toBe(32);
    const plain = formatLinkToken(secret);
    expect(plain).toMatch(/^fpl1\.[A-Za-z0-9_-]{43}$/);
    expect(parseLinkToken(plain)).toEqual({ secret });

    const withRelay = formatLinkToken(secret, "wss://relay.example.com/foxpilot");
    expect(withRelay.split(".")).toHaveLength(3);
    const parsed = parseLinkToken(withRelay);
    expect(parsed.secret.equals(secret)).toBe(true);
    expect(parsed.relayUrl).toBe("wss://relay.example.com/foxpilot");

    const lan = parseLinkToken(formatLinkToken(secret, "ws://192.168.1.5:8790"));
    expect(lan.relayUrl).toBe("ws://192.168.1.5:8790");
  });

  test("tolerates whitespace and one pair of surrounding quotes", () => {
    const secret = generateLinkSecret();
    const token = formatLinkToken(secret, "wss://r.example.com");
    for (const pasted of [`  ${token}\n`, `"${token}"`, `'${token}'`, ` " ${token} " `]) {
      const parsed = parseLinkToken(pasted);
      expect(parsed.secret.equals(secret)).toBe(true);
      expect(parsed.relayUrl).toBe("wss://r.example.com");
    }
  });

  test("formatLinkToken requires a 32-byte secret", () => {
    expect(() => formatLinkToken(Buffer.alloc(31))).toThrow();
    expect(() => formatLinkToken(Buffer.alloc(33))).toThrow();
  });

  test("rejects malformed tokens without leaking the secret", () => {
    const secret = generateLinkSecret();
    const secretText = b64(secret);
    const short = b64(crypto.randomBytes(31));
    const long = b64(crypto.randomBytes(33));
    const cases: Array<[string, string, RegExp]> = [
      [`fpl2.${secretText}`, secretText, /start with/],
      [`${secretText}`, secretText, /start with/],
      [`fpl1`, secretText, /parts/],
      [`fpl1.${secretText}.${b64(Buffer.from("wss://a.b"))}.extra`, secretText, /parts/],
      [`fpl1.${secretText.slice(0, 20)}!${secretText.slice(21)}`, secretText.slice(0, 20), /base64url/],
      [`fpl1.${short}`, short, /32 bytes, got 31/],
      [`fpl1.${long}`, long, /32 bytes, got 33/],
      [`fpl1.${secretText}.${b64(Buffer.from("ws://8.8.8.8"))}`, secretText, /relay URL/],
      [`fpl1.${secretText}.not+b64`, secretText, /relay URL part is not base64url/],
      [`fpl1.${secretText}.${b64(Buffer.from("ftp://x.example"))}`, secretText, /relay URL/],
      [`""`, secretText, /empty/],
    ];
    for (const [token, mustNotLeak, why] of cases) {
      let message = "";
      try {
        parseLinkToken(token);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/^Invalid FoxPilot link token:/);
      expect(message).toMatch(why);
      expect(message).not.toContain(mustNotLeak);
      expect(message).not.toContain(token);
    }
  });
});

describe("deriveRoomId", () => {
  test("is deterministic, well-formed and one-way", () => {
    const a = generateLinkSecret();
    const b = generateLinkSecret();
    const roomA = deriveRoomId(a);
    expect(deriveRoomId(Buffer.from(a))).toBe(roomA);
    expect(roomA).toHaveLength(32);
    expect(ROOM_ID_RE.test(roomA)).toBe(true);
    expect(deriveRoomId(b)).not.toBe(roomA);
    expect(b64(a)).not.toContain(roomA);
    expect(roomA).not.toContain(b64(a).slice(0, 8));
  });
});

describe("handshake", () => {
  test("establishes a channel that carries messages both ways", () => {
    const secret = generateLinkSecret();
    const client = new ClientHandshake(secret, { label: "  my\tcloud  box ", version: "1.0.0-beta" });
    const helloFrame = client.hello();
    expect(client.hello()).toBe(helloFrame);
    expect(isHandshakeFrame(helloFrame)).toBe(true);
    expect(isDataFrame(helloFrame)).toBe(false);

    const check = verifyHello(secret, helloFrame);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.hello.label).toBe("my cloud box");
    expect(check.hello.version).toBe("1.0.0-beta");

    const { welcome, channel: host } = buildWelcome(secret, check.hello, { version: "2.0.0" });
    const result = client.finish(welcome);
    expect(result.kind).toBe("established");
    if (result.kind !== "established") return;
    expect(result.peerVersion).toBe("2.0.0");
    const cli = result.channel;

    // Small messages, interleaved directions.
    const f1 = cli.seal("hello host");
    expect(f1).toHaveLength(1);
    expect(isDataFrame(f1[0])).toBe(true);
    expect(f1[0].startsWith("D0.0.1.")).toBe(true);
    expect(host.open(f1[0])).toBe("hello host");
    expect(cli.open(host.seal("hello client ✓ 🦊")[0])).toBe("hello client ✓ 🦊");

    // Empty string still yields exactly one part.
    const empty = cli.seal("");
    expect(empty).toHaveLength(1);
    expect(empty[0].startsWith("D1.0.1.")).toBe(true);
    expect(host.open(empty[0])).toBe("");

    // 1.5 MB, multi-part, both directions.
    const big = "x".repeat(1024 * 1024) + "é".repeat(256 * 1024);
    const bigFrames = cli.seal(big);
    expect(bigFrames.length).toBeGreaterThan(1);
    bigFrames.forEach((f, i) => {
      expect(f.startsWith(`D2.${i}.${bigFrames.length}.`)).toBe(true);
      const part = f.split(".")[3];
      expect(part.length).toBeLessThanOrEqual(LINK_CHUNK_CHARS);
    });
    expect(deliver(host, bigFrames)).toBe(big);
    expect(deliver(cli, host.seal(big))).toBe(big);

    // Sequence keeps going afterwards.
    expect(host.open(cli.seal("after")[0])).toBe("after");
  });

  test("a sealed frame does not open on the sending side's own key", () => {
    const { client } = handshake();
    const frame = client.seal("loop")[0];
    const { client: other } = handshake();
    expect(() => other.open(frame)).toThrow(LinkProtocolError);
  });

  test("wrong secret: hello fails verification and a foreign welcome fails finish", () => {
    const secret = generateLinkSecret();
    const wrong = generateLinkSecret();
    const client = new ClientHandshake(secret, { label: "a", version: "1" });
    const check = verifyHello(wrong, client.hello());
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toMatch(/authentication/);

    // A host holding another secret answers a hello it (wrongly) accepted.
    const good = verifyHello(secret, client.hello());
    if (!good.ok) throw new Error("expected ok");
    const { welcome } = buildWelcome(wrong, good.hello, { version: "1" });
    expect(() => client.finish(welcome)).toThrow(LinkProtocolError);
  });

  test("tampered hello MAC fails verification", () => {
    const secret = generateLinkSecret();
    const client = new ClientHandshake(secret, { label: "a", version: "1" });
    const tampered = editFrame(client.hello(), (m) => {
      m.m = flipChar(m.m as string, 5);
    });
    expect(verifyHello(secret, tampered).ok).toBe(false);
    const relabeled = editFrame(client.hello(), (m) => {
      m.l = "evil";
    });
    expect(verifyHello(secret, relabeled).ok).toBe(false);
  });

  test.each(["e", "n", "fv", "m"])("tampered welcome field %s makes finish throw", (field) => {
    const secret = generateLinkSecret();
    const client = new ClientHandshake(secret, { label: "a", version: "1" });
    const check = verifyHello(secret, client.hello());
    if (!check.ok) throw new Error("expected ok");
    const { welcome } = buildWelcome(secret, check.hello, { version: "1.0" });
    const tampered = editFrame(welcome, (m) => {
      m[field] = flipChar(m[field] as string, 1);
    });
    expect(() => client.finish(tampered)).toThrow(LinkProtocolError);
  });

  test("a validly MACed welcome with a degenerate key is refused", () => {
    // Simulates a malicious token holder: all-zero public key -> all-zero shared secret.
    const secret = generateLinkSecret();
    const client = new ClientHandshake(secret, { label: "a", version: "1" });
    const hello = JSON.parse(client.hello().slice(1));
    const authKey = Buffer.from(
      crypto.hkdfSync("sha256", secret, Buffer.from("foxpilot-link-v1"), "auth", 32)
    );
    const n = b64(crypto.randomBytes(16));
    const e = b64(Buffer.alloc(32));
    const m = crypto
      .createHmac("sha256", authKey)
      .update(JSON.stringify(["foxpilot-link", "welcome", 1, hello.n, hello.e, hello.l, hello.fv, n, e, "1"]))
      .digest("base64url");
    const welcome = "H" + JSON.stringify({ t: "welcome", v: 1, n, e, fv: "1", m });
    expect(() => client.finish(welcome)).toThrow(LinkProtocolError);
  });

  test("finish refuses garbage, wrong version and a second call", () => {
    const secret = generateLinkSecret();
    expect(() => new ClientHandshake(secret, { label: "a", version: "1" }).finish("Hnot json")).toThrow(
      LinkProtocolError
    );
    expect(() => new ClientHandshake(secret, { label: "a", version: "1" }).finish("D0.0.1.AAAA")).toThrow(
      LinkProtocolError
    );

    const client = new ClientHandshake(secret, { label: "a", version: "1" });
    const check = verifyHello(secret, client.hello());
    if (!check.ok) throw new Error("expected ok");
    const { welcome } = buildWelcome(secret, check.hello, { version: "1" });
    const v2 = editFrame(welcome, (m) => {
      m.v = 2;
    });
    expect(() => client.finish(v2)).toThrow(/version/);

    const fresh = new ClientHandshake(secret, { label: "a", version: "1" });
    const freshCheck = verifyHello(secret, fresh.hello());
    if (!freshCheck.ok) throw new Error("expected ok");
    const w = buildWelcome(secret, freshCheck.hello, { version: "1" }).welcome;
    expect(fresh.finish(w).kind).toBe("established");
    expect(() => fresh.finish(w)).toThrow(LinkProtocolError);
  });

  test("two handshakes with the same secret yield different session keys", () => {
    const secret = generateLinkSecret();
    const a = handshake(secret);
    const b = handshake(secret);
    const frame = a.client.seal("for session A only")[0];
    expect(() => b.host.open(frame)).toThrow(LinkProtocolError);
    expect(a.host.open(frame)).toBe("for session A only");
  });

  test("surfaces the sanitized label and versions", () => {
    const r = handshake(generateLinkSecret(), "laptop\u0000\u200bbox", "v1.2.3 (beta)");
    expect(r.hello.label).toBe("laptopbox");
    expect(r.hello.version).toBe("v1.2.3beta");
    expect(r.peerVersion).toBe("9.9.9");
  });
});

describe("reject flow", () => {
  test("a valid reject is surfaced with its reason", () => {
    const secret = generateLinkSecret();
    const client = new ClientHandshake(secret, { label: "a", version: "1" });
    const check = verifyHello(secret, client.hello());
    if (!check.ok) throw new Error("expected ok");
    const reject = buildReject(secret, check.hello, "Remote access is paused on this machine");
    expect(isHandshakeFrame(reject)).toBe(true);
    expect(client.finish(reject)).toEqual({
      kind: "rejected",
      reason: "Remote access is paused on this machine",
    });
  });

  test("the reason is cut to 200 chars", () => {
    const secret = generateLinkSecret();
    const client = new ClientHandshake(secret, { label: "a", version: "1" });
    const check = verifyHello(secret, client.hello());
    if (!check.ok) throw new Error("expected ok");
    const result = client.finish(buildReject(secret, check.hello, "r".repeat(500)));
    expect(result).toEqual({ kind: "rejected", reason: "r".repeat(200) });
  });

  test("a reject with a forged MAC or reason throws", () => {
    const secret = generateLinkSecret();
    const mk = () => {
      const client = new ClientHandshake(secret, { label: "a", version: "1" });
      const check = verifyHello(secret, client.hello());
      if (!check.ok) throw new Error("expected ok");
      return { client, hello: check.hello };
    };
    const one = mk();
    const forged = editFrame(buildReject(secret, one.hello, "no"), (m) => {
      m.m = flipChar(m.m as string, 3);
    });
    expect(() => one.client.finish(forged)).toThrow(LinkProtocolError);

    const two = mk();
    const swapped = editFrame(buildReject(secret, two.hello, "no"), (m) => {
      m.reason = "yes";
    });
    expect(() => two.client.finish(swapped)).toThrow(LinkProtocolError);

    // A reject built for another hello (another session) does not apply here.
    const three = mk();
    const other: VerifiedHello = mk().hello;
    expect(() => three.client.finish(buildReject(secret, other, "no"))).toThrow(LinkProtocolError);
  });
});

describe("verifyHello input validation", () => {
  const secret = generateLinkSecret();
  const helloFrame = () => new ClientHandshake(secret, { label: "box", version: "1.0" }).hello();

  test("rejects a v:2 hello", () => {
    const v2 = editFrame(helloFrame(), (m) => {
      m.v = 2;
    });
    const check = verifyHello(secret, v2);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/version/);
  });

  test("never throws on junk", () => {
    const junk: unknown[] = [
      "",
      "H",
      "Hnull",
      "H[]",
      'H{"t":"hello"}',
      "D0.0.1.AAAA",
      "H" + "x".repeat(100000),
      42,
      null,
      editFrame(helloFrame(), (m) => {
        m.n = "short";
      }),
      editFrame(helloFrame(), (m) => {
        m.e = 7;
      }),
      editFrame(helloFrame(), (m) => {
        m.t = "welcome";
      }),
    ];
    for (const frame of junk) {
      expect(() => verifyHello(secret, frame as string)).not.toThrow();
      expect(verifyHello(secret, frame as string).ok).toBe(false);
    }
    expect(verifyHello(Buffer.alloc(3), helloFrame()).ok).toBe(false);
  });

  test("requires the label and version to be in sanitized form", () => {
    const authKey = Buffer.from(
      crypto.hkdfSync("sha256", secret, Buffer.from("foxpilot-link-v1"), "auth", 32)
    );
    const forge = (l: string, fv: string) => {
      const n = b64(crypto.randomBytes(16));
      const e = crypto.generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x as string;
      const m = crypto
        .createHmac("sha256", authKey)
        .update(JSON.stringify(["foxpilot-link", "hello", 1, n, e, l, fv]))
        .digest("base64url");
      return "H" + JSON.stringify({ t: "hello", v: 1, n, e, l, fv, m });
    };
    expect(verifyHello(secret, forge("ok label", "1.0")).ok).toBe(true);
    expect(verifyHello(secret, forge("bad\nlabel", "1.0")).ok).toBe(false);
    expect(verifyHello(secret, forge("ok", "1.0 beta")).ok).toBe(false);
    expect(verifyHello(secret, forge("ok", "")).ok).toBe(false);
  });
});

describe("SecureChannel ordering and integrity", () => {
  function pair() {
    const k1 = crypto.randomBytes(32);
    const k2 = crypto.randomBytes(32);
    return { a: new SecureChannel(k1, k2), b: new SecureChannel(k2, k1) };
  }

  function expectDead(ch: SecureChannel, frame: string) {
    expect(() => ch.open(frame)).toThrow("link channel closed after a protocol error");
    expect(() => ch.seal("x")).toThrow("link channel closed after a protocol error");
  }

  test("requires 32-byte keys", () => {
    expect(() => new SecureChannel(Buffer.alloc(16), Buffer.alloc(32))).toThrow();
  });

  test("a flipped char in a data part fails authentication and kills the channel", () => {
    const { a, b } = pair();
    const [frame] = a.seal("secret payload");
    const head = frame.lastIndexOf(".") + 1;
    expect(() => b.open(flipChar(frame, head + 4))).toThrow(LinkProtocolError);
    expectDead(b, frame);
  });

  test("a replayed frame throws and kills the channel", () => {
    const { a, b } = pair();
    const [frame] = a.seal("once");
    expect(b.open(frame)).toBe("once");
    expect(() => b.open(frame)).toThrow(LinkProtocolError);
    expectDead(b, a.seal("next")[0]);
  });

  test("a skipped seq throws and kills the channel", () => {
    const { a, b } = pair();
    const [first] = a.seal("one");
    const [second] = a.seal("two");
    expect(() => b.open(second)).toThrow(/sequence/);
    expectDead(b, first);
  });

  test("rewriting the seq header does not get a frame past the nonce binding", () => {
    const { a, b } = pair();
    a.seal("dropped");
    const [second] = a.seal("two");
    expect(() => b.open(second.replace(/^D1\./, "D0."))).toThrow(/authentication/);
  });

  test("parts delivered out of order throw and kill the channel", () => {
    const { a, b } = pair();
    const frames = a.seal("y".repeat(LINK_CHUNK_CHARS));
    expect(frames.length).toBeGreaterThan(1);
    expect(() => b.open(frames[1])).toThrow(/order/);
    expectDead(b, frames[0]);
  });

  test("a part count that changes mid-message throws", () => {
    const { a, b } = pair();
    const frames = a.seal("z".repeat(LINK_CHUNK_CHARS));
    expect(b.open(frames[0])).toBeNull();
    expect(() => b.open(frames[1].replace(/^D0\.1\.2\./, "D0.1.3."))).toThrow(/count/);
  });

  test("malformed headers and out-of-range counts throw", () => {
    for (const bad of [
      "D0.0.1.ab+c",
      "D0.0.0.AAAA",
      `D0.0.${LINK_MAX_PARTS + 1}.AAAA`,
      "D00.0.1.AAAA",
      "D0.00.1.AAAA",
      "X0.0.1.AAAA",
      "D0.0.1",
    ]) {
      const { b } = pair();
      expect(() => b.open(bad)).toThrow(LinkProtocolError);
    }
  });

  test("seal refuses a message beyond LINK_MAX_PARTS without consuming a seq", () => {
    const { a, b } = pair();
    const tooBig = "q".repeat(Math.ceil((LINK_CHUNK_CHARS * LINK_MAX_PARTS * 3) / 4) + 1);
    expect(() => a.seal(tooBig)).toThrow(/too large/);
    expect(b.open(a.seal("still fine")[0])).toBe("still fine");
  });
});

describe("sanitizers", () => {
  test("sanitizeLabel", () => {
    expect(sanitizeLabel("  dev   box  ")).toBe("dev box");
    expect(sanitizeLabel("a\nb\tc\r\nd")).toBe("a b c d");
    expect(sanitizeLabel("x\u0000\u0007\u001b[31my\u200b\u202e")).toBe("x[31my");
    expect(sanitizeLabel("")).toBe("remote");
    expect(sanitizeLabel("\u0000\n\t ")).toBe("remote");
    expect(sanitizeLabel("é🦊 ok")).toBe("é🦊 ok");
    const long = sanitizeLabel("L".repeat(500));
    expect(long).toBe("L".repeat(LINK_LABEL_MAX));
    // Cut lands right after a space: the result is still trimmed and idempotent.
    const edge = sanitizeLabel("a".repeat(LINK_LABEL_MAX - 1) + " bcd");
    expect(edge).toBe("a".repeat(LINK_LABEL_MAX - 1));
    // Never splits a surrogate pair.
    const emoji = sanitizeLabel("🦊".repeat(100));
    expect(Array.from(emoji)).toHaveLength(LINK_LABEL_MAX);
    for (const s of [long, edge, emoji, "dev box", "remote"]) {
      expect(sanitizeLabel(s)).toBe(s);
    }
  });

  test("sanitizeVersion", () => {
    expect(sanitizeVersion("1.2.3")).toBe("1.2.3");
    expect(sanitizeVersion("1.2.3-beta+build_7")).toBe("1.2.3-beta+build_7");
    expect(sanitizeVersion(" v1.0 \n(rc)\u0000")).toBe("v1.0rc");
    expect(sanitizeVersion("")).toBe("unknown");
    expect(sanitizeVersion("!!!")).toBe("unknown");
    expect(sanitizeVersion("9".repeat(100))).toBe("9".repeat(32));
  });
});
