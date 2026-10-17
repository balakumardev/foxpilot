// Reports are public, unauthenticated input that ends up in an issue tracker, where people
// and automated agents read it. Everything here makes text inert: no hidden characters, no
// mentions, links, images, HTML or entities, and no "key=value" directives that could steer
// automation (repository, agent or model selection).

// Control, format and default-ignorable characters hide text from reviewers and reshape
// bidi rendering. Plain newlines and tabs stay.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}]/u;
const ZWJ = "‍";

function stripInvisible(s: string): string {
  const cps = [...s.replace(/\r\n?|[\u{2028}\u{2029}]/gu, "\n")];
  let out = "";
  let prev = "";
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    // A joiner between two emoji is what makes a family or profession emoji one glyph.
    const keep =
      c === "\n" ||
      c === "\t" ||
      !INVISIBLE.test(c) ||
      (c === ZWJ && EMOJI.test(prev) && i + 1 < cps.length && EMOJI.test(cps[i + 1]));
    if (keep) {
      out += c;
      prev = c;
    }
  }
  return out;
}

/** Single-line text: invisible characters removed, whitespace collapsed. */
export function cleanLine(s: string): string {
  return stripInvisible(s).replace(/\s+/g, " ").trim();
}

/** Multi-line text: invisible characters removed, line structure kept. */
export function cleanText(s: string): string {
  return stripInvisible(s).trim();
}

const FULLWIDTH_AT = "＠";
const FULLWIDTH_LEFT_BRACKET = "［";
const FULLWIDTH_RIGHT_BRACKET = "］";
const FULLWIDTH_EQUALS = "＝";
const FULLWIDTH_LT = "＜";
const FULLWIDTH_GT = "＞";
const FULLWIDTH_PIPE = "｜";

// Routing directives such as "repos=", "repo=", "agent=" and "model=" can steer an automation
// that reads the issue. Markdown emphasis or escapes between the letters (r*e*p*o*s, `repo`=)
// would hide them from a naive filter yet still render as the word, so tolerate that markup.
const MARKUP = "[*_`~\\\\]*";
const KEYWORDS = ["repos", "repo", "agent", "model"].map((k) => [...k].join(MARKUP)).join("|");
const KEYWORD_EQUALS = new RegExp(`(?<![A-Za-z0-9])(${KEYWORDS})([\\s*_\`~\\\\]*)=`, "gi");

// Visually near-identical characters replace the ones that would otherwise become a mention,
// link, image, tag or directive. Linear's own domain is broken up so a report cannot make
// the tracker unfurl or cross-link an internal issue URL.
function swapLookalikes(s: string): string {
  return s
    .replace(/@/g, FULLWIDTH_AT)
    .replace(/\[/g, FULLWIDTH_LEFT_BRACKET)
    .replace(/\]/g, FULLWIDTH_RIGHT_BRACKET)
    .replace(/</g, FULLWIDTH_LT)
    .replace(/>/g, FULLWIDTH_GT)
    .replace(KEYWORD_EQUALS, `$1$2${FULLWIDTH_EQUALS}`)
    .replace(/linear\.app/gi, (m) => `${m.slice(0, 6)}[.]${m.slice(7)}`);
}

// Markdown decodes backslash escapes and HTML entities, which would turn an escaped or
// entity-encoded character back into the one swapLookalikes just removed.
function escapeMarkdownDecoding(s: string): string {
  return s.replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\").replace(/&(?=[#A-Za-z])/g, "&amp;");
}

/** For markdown bodies. */
export function neutralize(s: string): string {
  return swapLookalikes(escapeMarkdownDecoding(s));
}

/** For plain-text fields such as the issue title. */
export function neutralizePlain(s: string): string {
  return swapLookalikes(s);
}

/** For a cell in a markdown table: also keeps the text from ending the cell. */
export function tableCell(s: string): string {
  return neutralize(cleanLine(s)).replace(/\|/g, FULLWIDTH_PIPE);
}
