import { describe, expect, it } from "vitest";
import { cleanLine, cleanText, neutralize, neutralizePlain, tableCell } from "../src/sanitize";

const FW_EQUALS = "\uFF1D";

describe("cleanLine / cleanText", () => {
  it.each([
    ["zero-width space", "a\u200Bb"],
    ["zero-width non-joiner", "a\u200Cb"],
    ["byte order mark", "a\uFEFFb"],
    ["soft hyphen", "a\u00ADb"],
    ["word joiner", "a\u2060b"],
    ["bidi override (RLO)", "a\u202Eb"],
    ["bidi embedding (LRE)", "a\u202Ab"],
    ["bidi isolate (RLI)", "a\u2067b"],
    ["left-to-right mark", "a\u200Eb"],
    ["Hangul filler", "a\u3164b"],
    ["Unicode tag character", "a\u{E0041}b"],
    ["variation selector", "a\uFE0Fb"],
    ["NUL", "a\u0000b"],
    ["bell", "a\u0007b"],
    ["escape", "a\u001Bb"],
    ["next line (NEL)", "a\u0085b"],
    ["DEL", "a\u007Fb"],
  ])("removes %s", (_name, input) => {
    expect(cleanLine(input)).toBe("ab");
    expect(cleanText(input)).toBe("ab");
  });

  it("keeps ordinary non-ASCII text", () => {
    expect(cleanText("naïve café 日本語 Привет \u{1F680}")).toBe("naïve café 日本語 Привет \u{1F680}");
  });

  describe("zero-width joiner", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";

    it("keeps one between two emoji", () => {
      expect(cleanText(family)).toBe(family);
      expect(cleanLine(`x ${family} y`)).toBe(`x ${family} y`);
    });

    it("keeps one after an emoji modifier", () => {
      const person = "\u{1F9D1}\u{1F3FD}\u200D\u{1F4BB}";
      expect(cleanText(person)).toBe(person);
    });

    it.each([
      ["between letters", "a\u200Db", "ab"],
      ["at the start", "\u200D\u{1F468}", "\u{1F468}"],
      ["at the end", "\u{1F468}\u200D", "\u{1F468}"],
      ["after an emoji, before a letter", "\u{1F468}\u200Da", "\u{1F468}a"],
      ["after a letter, before an emoji", "a\u200D\u{1F468}", "a\u{1F468}"],
      ["repeated", "\u{1F468}\u200D\u200D\u{1F469}", "\u{1F468}\u200D\u{1F469}"],
    ])("removes one %s", (_name, input, expected) => {
      expect(cleanText(input)).toBe(expected);
    });
  });

  it("normalises line endings", () => {
    expect(cleanText("a\r\nb\rc\u2028d\u2029e\nf")).toBe("a\nb\nc\nd\ne\nf");
  });

  it("keeps tabs and newlines in text but collapses all whitespace in a line", () => {
    expect(cleanText("a\tb\n\nc")).toBe("a\tb\n\nc");
    expect(cleanLine("a\tb\n\n  c\u00A0d")).toBe("a b c d");
  });

  it("trims", () => {
    expect(cleanText("  \n a \n  ")).toBe("a");
    expect(cleanLine("  a  ")).toBe("a");
  });
});

describe("neutralize", () => {
  const dangerous = /[@[\]<>]/;

  it("replaces mentions, brackets, angle brackets with look-alikes", () => {
    const out = neutralize("hi @alice and @here <b>x</b> [a](http://e.test) ![i](http://e.test/p.png)");
    expect(out).not.toMatch(dangerous);
    expect(out).toContain("\uFF20alice");
    expect(out).toContain("\uFF1Cb\uFF1E");
    expect(out).toContain("\uFF3Ba\uFF3D(http://e.test)");
  });

  it("defuses HTML comments and script tags", () => {
    const out = neutralize("<!-- hidden --><script>alert(1)</script>");
    expect(out).not.toMatch(/[<>]/);
  });

  it("keeps a markdown backslash escape from decoding back to a dangerous character", () => {
    expect(neutralize("\\@alice \\[x\\]")).toBe("\\\\\uFF20alice \\\\\uFF3Bx\\\\\uFF3D");
  });

  it("keeps an HTML entity from decoding back to a dangerous character", () => {
    expect(neutralize("&#64;alice &lt;b&gt; &#x3C; &amp;")).toBe("&amp;#64;alice &amp;lt;b&amp;gt; &amp;#x3C; &amp;amp;");
  });

  it("leaves a bare ampersand and a backslash before a letter alone", () => {
    expect(neutralize("a & b, a && b, C:\\temp, 5 &")).toBe("a & b, a && b, C:\\temp, 5 &");
  });

  it.each(["linear.app", "LINEAR.APP", "Linear.App"])("breaks up %s", (domain) => {
    const out = neutralize(`see https://${domain}/team/issue/ABC-1`);
    expect(out).not.toMatch(/linear\.app/i);
    expect(out).toContain(`${domain.slice(0, 6)}[.]${domain.slice(7)}`);
  });

  it("does not touch other text, markdown emphasis or bare URLs", () => {
    const text = "**bold** _it_ `code` # heading\n- item\nhttps://example.com/a?b=c";
    expect(neutralize(text)).toBe(text);
  });

  describe("routing directives", () => {
    const neutralised = [
      "repos=owner/name",
      "repo=owner/name",
      "agent=builder",
      "model=big-model",
      "REPOS=owner/name",
      "Repo =owner/name",
      "model   =  x",
      "repos\t=x",
      "repos\n=x",
      "r*e*p*o*s=x",
      "r_e_p_o=x",
      "**repos**=x",
      "__repo__ = x",
      "`repo`=x",
      "~~agent~~ = x",
      "_model_=x",
      "*a*g*e*n*t*=x",
      "repo\\=x",
      "re\\po=x",
      "(repos=x)",
      "my_repo=x",
      "prefix: repo=x, then agent=y",
    ];

    it.each(neutralised)("neutralises %j", (input) => {
      const out = neutralize(input);
      expect(out).not.toContain("=");
      expect(out).toContain(FW_EQUALS);
      expect(neutralizePlain(input)).not.toContain("=");
    });

    it("replaces only the equals sign and keeps the surrounding text", () => {
      expect(neutralize("repos=a/b")).toBe(`repos${FW_EQUALS}a/b`);
      expect(neutralize("**repo** =x")).toBe(`**repo** ${FW_EQUALS}x`);
      expect(neutralize("Model = x")).toBe(`Model ${FW_EQUALS} x`);
    });

    it("neutralises every directive in a text", () => {
      expect(neutralize("repos=a agent=b\nmodel=c")).toBe(
        `repos${FW_EQUALS}a agent${FW_EQUALS}b\nmodel${FW_EQUALS}c`
      );
    });

    it("cannot be smuggled through an entity-encoded equals sign", () => {
      const out = neutralize("repos&#61;x repos&equals;x");
      expect(out).not.toContain("&#");
      expect(out).toContain("&amp;#61;");
    });

    it("cannot be smuggled through hidden characters once the text is cleaned", () => {
      const out = neutralize(cleanText("re\u200Bpos\u202E=x"));
      expect(out).toBe(`repos${FW_EQUALS}x`);
    });

    it.each(["prerepos=1", "xmodel=1", "models=1", "agents=1", "repository=1", "reposx=1", "a=b", "x==y", "model: x"])(
      "leaves %j alone",
      (input) => {
        expect(neutralize(input)).toBe(input);
      }
    );
  });
});

describe("neutralizePlain", () => {
  it("swaps look-alikes but does not escape backslashes or ampersands", () => {
    expect(neutralizePlain("@bob [x] <y> a\\b & c")).toBe("\uFF20bob \uFF3Bx\uFF3D \uFF1Cy\uFF1E a\\b & c");
  });

  it("breaks up the Linear domain and routing directives", () => {
    expect(neutralizePlain("linear.app agent=x")).toBe(`linear[.]app agent${FW_EQUALS}x`);
  });
});

describe("tableCell", () => {
  it("replaces pipes so the value cannot end its cell", () => {
    const out = tableCell("a | b || c");
    expect(out).not.toContain("|");
    expect(out).toBe("a \uFF5C b \uFF5C\uFF5C c");
  });

  it("collapses newlines so the value cannot end its row", () => {
    expect(tableCell("one\ntwo\r\nthree")).toBe("one two three");
  });

  it("neutralises markup and a pipe preceded by a backslash", () => {
    expect(tableCell("@bob\\|x")).toBe("\uFF20bob\\\\\uFF5Cx");
  });
});
