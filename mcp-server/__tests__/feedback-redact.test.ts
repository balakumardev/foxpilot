import { redactSensitive } from "../feedback-client";

// Secret-looking fixtures are assembled at runtime so no source line looks like
// a real credential to a repository secret scanner.
const GHP = "gh" + "p_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";
const GH_PAT = "github" + "_pat_" + "11ABCDEFG0aB3dE5fG7hJ9_kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3kL5";
const SK = "sk" + "-proj-" + "abc123DEF456ghi789JKL012mno345";
const SLACK = "xox" + "b-" + "1234567890-abcdefghijKLMN";
const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
const GOOGLE = "AIza" + "SyA1234567890abcdefghijklmnopqrstuv";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const LINK = "fpl1." + "aGVsbG8tc2VjcmV0LXZhbHVl" + "." + "aHR0cHM6Ly9yZWxheS5leGFtcGxlLm9yZw";

const R = "[redacted]";

function red(s: string): string {
  return redactSensitive(s).text;
}

describe("redactSensitive: what it removes", () => {
  it("FoxPilot link tokens, with and without the relay part", () => {
    expect(red(`link ${LINK} used`)).toBe(`link ${R} used`);
    expect(red("FOXPILOT_LINK=fpl1.legacySecret_123-abc")).toBe(`FOXPILOT_LINK=${R}`);
  });

  it("Authorization, Cookie and Set-Cookie header values", () => {
    expect(red("Authorization: Basic dXNlcjpwYXNz")).toBe(`Authorization: ${R}`);
    expect(red("authorization:Bearer abc.def")).toBe(`authorization:${R}`);
    expect(red("Cookie: sid=abc123; theme=dark\nHost: x")).toBe(`Cookie: ${R}\nHost: x`);
    expect(red("Set-Cookie: session=zzz; HttpOnly; Secure")).toBe(`Set-Cookie: ${R}`);
    expect(red("Proxy-Authorization: Basic abcdef")).toBe(`Proxy-Authorization: ${R}`);
  });

  it("header values inside JSON or quotes", () => {
    expect(red('{"Authorization": "Bearer abc123def456", "x": 1}')).toBe(
      `{"Authorization": "${R}", "x": 1}`
    );
    expect(red(`{'cookie':'a=b; c=d'}`)).toBe(`{'cookie':'${R}'}`);
  });

  it("Bearer tokens", () => {
    expect(red("sent Bearer abc123DEF456ghi789 to it")).toBe(`sent Bearer ${R} to it`);
    expect(red("bearer " + "A".repeat(30))).toBe(`bearer ${R}`);
  });

  it("JWTs", () => {
    expect(red(`token was ${JWT}.`)).toBe(`token was ${R}.`);
  });

  it.each([
    ["OpenAI/Anthropic style", SK],
    ["GitHub classic", GHP],
    ["GitHub fine-grained", GH_PAT],
    ["Slack", SLACK],
    ["AWS access key", AWS],
    ["Google API key", GOOGLE],
    ["npm", "npm" + "_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"],
    ["GitLab", "glpat" + "-" + "aB3dE5fG7hJ9kL1mN3pQ"],
    ["Stripe", "sk" + "_live_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7"],
    ["Google OAuth", "ya29" + "." + "a0AfB_byC1d2E3f4G5h6I7j8K9l0"],
  ])("API key shape: %s", (_name, key) => {
    expect(red(`the key ${key} leaked`)).toBe(`the key ${R} leaked`);
    expect(red(`${key}`)).toBe(R);
  });

  it("values assigned to key-looking names", () => {
    expect(red("api_key=abcd1234efgh5678")).toBe(`api_key=${R}`);
    expect(red("API-KEY: abcd1234efgh5678")).toBe(`API-KEY: ${R}`);
    expect(red("export GITHUB_TOKEN=abcd1234efgh5678")).toBe(`export GITHUB_TOKEN=${R}`);
    expect(red("client_secret = 'zxcv1234asdf5678'")).toBe(`client_secret = '${R}'`);
    expect(red('{"access_token":"abcd1234efgh5678"}')).toBe(`{"access_token":"${R}"}`);
    expect(red("password=hunter2")).toBe(`password=${R}`);
    expect(red("passwd: correcthorse")).toBe(`passwd: ${R}`);
    expect(red("secret: " + "Q".repeat(30))).toBe(`secret: ${R}`);
  });

  it("URL query strings and fragments, keeping scheme, host and path", () => {
    expect(red("open https://app.example.com/a/b?token=abc&x=1#top now")).toBe(
      `open https://app.example.com/a/b?${R} now`
    );
    expect(red("at https://example.com/#/inbox/12345")).toBe(`at https://example.com/#${R}`);
    expect(red("http://localhost:3000/cb?code=zz")).toBe(`http://localhost:3000/cb?${R}`);
    expect(red("wss://relay.example.com/v1/rooms/x/host?auth=1")).toBe(
      `wss://relay.example.com/v1/rooms/x/host?${R}`
    );
  });

  it("URL credentials", () => {
    expect(red("clone https://user:pw1234@github.com/org/repo.git please")).toBe(
      "clone https://github.com/org/repo.git please"
    );
  });

  it("leaves trailing punctuation and brackets around a URL alone", () => {
    expect(red("see (https://x.io/a?b=c).")).toBe(`see (https://x.io/a?${R}).`);
    expect(red("[docs](https://x.io/a?b=c)")).toBe(`[docs](https://x.io/a?${R})`);
    expect(red("[https://x.io/a?b=c]")).toBe(`[https://x.io/a?${R}]`);
  });

  it("email addresses", () => {
    expect(red("contact bob.smith+tag@example.co.uk about it")).toBe("contact [email] about it");
    expect(red("a@b.io,c@d.io")).toBe("[email],[email]");
  });

  it("home-directory paths", () => {
    expect(red("failed at /Users/balakumar/personal/foxpilot/x.ts:3")).toBe(
      "failed at ~/personal/foxpilot/x.ts:3"
    );
    expect(red("log in (/home/ubuntu/.cache/foxpilot)")).toBe("log in (~/.cache/foxpilot)");
    expect(red("C:\\Users\\Alice\\AppData\\Local\\x")).toBe("~\\AppData\\Local\\x");
    expect(red("C:/Users/Alice/Desktop")).toBe("~/Desktop");
    expect(red("C:\\Users\\Bob Smith\\Desktop")).toBe("~\\Desktop");
    expect(red("file:///Users/zed/a.txt")).toBe("file://~/a.txt");
    expect(red("path=/Users/zed")).toBe("path=~");
  });

  it("several kinds in one text, counted once each", () => {
    const text = `Cookie: a=b\nmail me@x.io\nat /Users/u/p\nkey ${GHP}`;
    const r = redactSensitive(text);
    expect(r.text).toBe(`Cookie: ${R}\nmail [email]\nat ~/p\nkey ${R}`);
    expect(r.count).toBe(4);
  });

  it("counts replacements, and zero when nothing matched", () => {
    expect(redactSensitive("nothing to see").count).toBe(0);
    expect(redactSensitive(`${GHP} and ${AWS}`).count).toBe(2);
  });
});

describe("redactSensitive: what it leaves alone", () => {
  it.each([
    "click-element returned 'Clicked element e2 (page navigated)' but the page did not react.",
    "take-snapshot gives [snapshot: 0 elements] on https://example.com/pricing for a logged-out page.",
    "FoxPilot 1.0.30 on darwin-arm64, node v22.21.1, Chrome 149, tab id 1204, uid=e12.",
    "Timed out waiting for response from the browser extension after 15000ms.",
    "The password field is empty and the token counter shows 12. The secret santa list is long.",
    "Cookie banner is shown. Authorization is required before the page loads.",
    "Set the credentials option to include so the request is sent with the session.",
    "The API key input is hidden behind an overlay and the secret toggle does not respond.",
    "Version 1.0.30 of mcp-server/server.ts and common/server-messages.ts, line 482.",
    "this.state.value, app.factors.ai, node_modules/foo.bar.baz and a.b.c.d are not secrets.",
    "Navigate to https://example.com/home/settings and click Save.",
    "The package sk-learn-pipeline-transformer and the task-runner are unrelated.",
    "Use user@localhost style names? No: just localhost:8089 and 127.0.0.1.",
    "mailto: links and @scope/package names and #123 references stay.",
    "const token = getToken(session); password = prompt('x'); apiKeyField = tokenizer;",
    "token: required\npassword: needed\nsecret: none",
    "Bearer authentication is not supported here.",
  ])("unchanged: %s", (text) => {
    const r = redactSensitive(text);
    expect(r.text).toBe(text);
    expect(r.count).toBe(0);
  });

  it("does not treat hex ids or hashes without a secret-looking name as secrets", () => {
    const text = "commit 5da7727 and 3f786850e387550fdab836ed7e6dc881de23001b, uuid 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    expect(red(text)).toBe(text);
  });
});

describe("redactSensitive: idempotence", () => {
  it("redacting redacted text changes nothing and reports zero", () => {
    const text = [
      `Authorization: Bearer ${GHP}`,
      `url https://u:p@host.io/a?b=c#d and ${JWT}`,
      `FOXPILOT_LINK=${LINK} mail a@b.io /Users/me/x C:\\Users\\Me\\y`,
      "password=hunter2 api_key=abcd1234efgh5678",
    ].join("\n");
    const once = redactSensitive(text);
    const twice = redactSensitive(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
    expect(once.count).toBeGreaterThan(5);
  });

  it("holds on seeded random mixtures of fragments", () => {
    let seed = 20241016;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const frags = [
      "token=", "password:", '"secret": "', "Bearer ", "Cookie: ", "Authorization: ", "https://",
      "http://u:p@h.io", "/a/b?x=1#f", "?", "#", R, "[email]", "a@b.co", "/Users/bob", "/home/al",
      "C:\\Users\\Al", "\\", "/", "eyJhbGciOiJI", ".", "-", "_", "sk-", "ghp_", "AKIA", "fpl1.",
      "abc12345", "abcdefgh12345678", " ", "\n", '"', "'", "(", ")", "]", "[", "file://", "~", "xoxb-",
      "x".repeat(30), "1234567890",
    ];
    for (let i = 0; i < 6000; i++) {
      let s = "";
      const n = 1 + Math.floor(rnd() * 14);
      for (let j = 0; j < n; j++) s += frags[Math.floor(rnd() * frags.length)];
      const once = redactSensitive(s);
      const twice = redactSensitive(once.text);
      if (twice.text !== once.text || twice.count !== 0) {
        throw new Error(`not idempotent for ${JSON.stringify(s)}: ${JSON.stringify(once.text)} -> ${JSON.stringify(twice.text)}`);
      }
    }
  });
});

describe("redactSensitive: hostile 64 KB inputs finish quickly", () => {
  const N = 64 * 1024;
  const rep = (s: string) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const cases: Record<string, string> = {
    letters: rep("a"),
    ats: rep("@"),
    "local parts": rep("a@"),
    dots: rep("."),
    dashes: rep("-"),
    spaces: rep(" "),
    "token keyword": rep("token"),
    "token assignment": rep("token="),
    "keyword then spaces": "token" + " ".repeat(N),
    "bearer repeated": rep("Bearer "),
    "bearer then spaces": "Bearer" + " ".repeat(N),
    "cookie repeated": rep("Cookie:"),
    "cookie then spaces": "cookie:" + " ".repeat(N),
    "scheme repeated": rep("http://"),
    "one long host": "http://" + "a".repeat(N),
    "short schemes": rep("a://"),
    "long query": "https://x.com/?" + "a".repeat(N),
    "unix home": rep("/Users/"),
    "unix home names": rep("/home/a "),
    "windows home": rep("C:\\Users\\a b "),
    "windows long": "C:\\Users\\" + "a ".repeat(N / 2),
    "jwt prefix": rep("eyJ"),
    "jwt long": "eyJ" + "a".repeat(N / 2) + "." + "b".repeat(N / 2),
    "link token": rep("fpl1."),
    "link token long": "fpl1.aaaa" + ".a".repeat(N / 2),
    "sk prefix": rep("sk-"),
    "sk long": "sk-" + "a".repeat(N),
    "ghp long": "ghp_" + "a".repeat(N),
    "slack prefix": rep("xoxb-"),
    "aws prefix": rep("AKIA"),
    "mixed": rep("user@example.com https://a.b/c?d=e token=abc12345678 /Users/x "),
    "markers": rep("[redacted]"),
    "url markers": rep("https://a/b?[redacted]]"),
    "long email": "a".repeat(N / 2) + "@" + "b".repeat(N / 2) + ".com",
    "many labels": "a@" + "b.".repeat(N / 2),
    "json header": rep('{"Authorization": "'),
    newlines: rep("\n"),
    quotes: rep("\"'"),
    unicode: rep("é"),
  };

  it.each(Object.entries(cases))("%s", (_name, input) => {
    expect(input.length).toBeLessThanOrEqual(N + 16);
    const start = performance.now();
    redactSensitive(input);
    const elapsed = performance.now() - start;
    // Linear work is a few dozen milliseconds; backtracking blows up to seconds.
    expect(elapsed).toBeLessThan(1000);
  });
});
