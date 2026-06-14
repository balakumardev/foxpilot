// Produces a clean, Chrome-loadable bundle from the built extension.
//
// Chrome refuses to load any extension whose directory tree contains a
// `_`-prefixed entry ("Filenames starting with _ are reserved for use by the
// system"), so the source dir — which contains `__tests__/` (and node_modules,
// .ts sources, configs) — cannot be loaded directly via "Load unpacked" or
// zipped for the Chrome Web Store. This copies ONLY the runtime files into a
// clean output dir and zips it.
//
// Usage: `npm run package` (runs build first). Then load
// `web-ext-artifacts/chrome-unpacked/` via chrome://extensions → Load unpacked,
// or upload `web-ext-artifacts/foxpilot-chrome-<version>.zip` to the Web Store.
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const outRoot = join(root, "web-ext-artifacts");
const unpacked = join(outRoot, "chrome-unpacked");
const zipPath = join(outRoot, `foxpilot-chrome-${version}.zip`);

// Runtime allowlist — everything Chrome needs to load + run, nothing else.
// (Excludes __tests__, node_modules, *.ts sources, tsconfig/jest/package.json.)
const include = ["manifest.json", "offscreen.html", "options.html", "dist", "assets"];

if (!existsSync(join(root, "dist", "background.js"))) {
  console.error("dist/ is not built — run `npm run build` first.");
  process.exit(1);
}

rmSync(unpacked, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(unpacked, { recursive: true });
for (const item of include) {
  const src = join(root, item);
  if (existsSync(src)) cpSync(src, join(unpacked, item), { recursive: true });
}

// Guard: Chrome rejects the whole extension if any top-level entry starts with `_`.
const reserved = readdirSync(unpacked).filter((n) => n.startsWith("_"));
if (reserved.length) {
  console.error("Refusing to package — reserved `_`-prefixed entries present:", reserved);
  process.exit(1);
}

execSync(`cd "${unpacked}" && zip -qr "${zipPath}" .`, { stdio: "inherit" });

console.log("FoxPilot Chrome extension packaged (v" + version + "):");
console.log("  unpacked (chrome://extensions → Load unpacked):", unpacked);
console.log("  zip (Chrome Web Store upload):                  ", zipPath);
