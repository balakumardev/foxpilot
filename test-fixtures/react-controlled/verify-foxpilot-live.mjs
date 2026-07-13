// One-command acceptance test for the INSTALLED FoxPilot extension.
// Run AFTER reloading the extension (Automation Mode ON) and with the React
// fixture server up (node server.mjs 8771):
//     node test-fixtures/react-controlled/verify-foxpilot-live.mjs
// Drives the real extension through the broker (covert + engine:"cdp") against
// http://localhost:8771/ and asserts React state via #state-mirror.
import { execSync } from "node:child_process";

const FIX = "http://localhost:8771/";
function fp(tool, args = {}) {
  const out = execSync(`mcpkit call foxpilot ${tool} '${JSON.stringify(args)}'`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return out;
}
function openFixtureTab() {
  // open-browser-tab now accepts localhost (D22); fall back to example.com+navigate for older builds.
  let t;
  try { t = fp("open-browser-tab", { url: FIX }); } catch { t = fp("open-browser-tab", { url: "https://example.com/" }); }
  const id = Number((t.match(/tab id (\d+)/) || t.match(/id (\d+)/) || [])[1]);
  fp("navigate-tab", { tabId: id, url: FIX });
  return id;
}
function snapshot(tab) {
  const s = fp("take-snapshot", { tabId: tab });
  const map = {};
  for (const line of s.split("\n")) {
    const m = line.match(/"([^"]+)".*\[uid=(e\d+)\]/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}
function mirror(tab) {
  const c = fp("get-tab-web-content", { tabId: tab });
  const m = c.match(/\{\s*"text"[\s\S]*?"submitted":[^}]*\}/);
  try { return JSON.parse(m[0]); } catch { return null; }
}
const results = [];
const check = (name, cond, got) => { results.push({ name, pass: !!cond, got }); console.log((cond ? "PASS" : "FAIL") + "  " + name + "  " + JSON.stringify(got)); };

console.log("Opening fixture tab in the installed extension...");
const tab = openFixtureTab();
let uid = snapshot(tab);

console.log("\n--- COVERT (default) ---");
fp("fill-element", { tabId: tab, uid: uid["Text input"], value: "fp-covert" });
check("covert fill text", mirror(tab)?.text === "fp-covert", mirror(tab)?.text);
fp("fill-element", { tabId: tab, uid: uid["Select"], value: "Beta" });
check("covert select-by-text", mirror(tab)?.sel === "beta", mirror(tab)?.sel);
fp("click-element", { tabId: tab, uid: uid["Agree"] });
check("covert checkbox click", mirror(tab)?.checked === true, mirror(tab)?.checked);
fp("click-element", { tabId: tab, uid: uid["Increment"] });
check("covert button click", mirror(tab)?.count >= 1, mirror(tab)?.count);
fp("click-element", { tabId: tab, uid: uid["Open card"] });
check("covert role-less card click", mirror(tab)?.cardClicks >= 1, mirror(tab)?.cardClicks);
uid = snapshot(tab);
fp("click-element", { tabId: tab, uid: uid["Message input"] });
fp("type-text", { tabId: tab, text: "hello-chat" });
check("covert contenteditable type", (mirror(tab)?.chat || "").includes("hello-chat"), mirror(tab)?.chat);
uid = snapshot(tab);
fp("click-element", { tabId: tab, uid: uid["Text input"] });
fp("press-key", { tabId: tab, key: "Enter" });
const km = mirror(tab);
check("covert press-key key/code reach React", km?.lastKey === "Enter" && km?.lastCode === "Enter", { key: km?.lastKey, code: km?.lastCode, keyCode: km?.lastKeyCode });
console.log("   (finding #1: lastKeyCode above — 13 means covert keyCode DOES cross isolated→page; 0 means it does not, and engine:'cdp' is the answer)");

console.log("\n--- NON-COVERT (engine:'cdp', trusted) ---");
uid = snapshot(tab);
fp("fill-element", { tabId: tab, uid: uid["First name"], value: "CDPName", engine: "cdp" });
check("cdp fill", mirror(tab)?.fname === "CDPName", mirror(tab)?.fname);
uid = snapshot(tab);
const beforeCount = mirror(tab)?.count;
fp("click-element", { tabId: tab, uid: uid["Increment"], engine: "cdp" });
check("cdp click", mirror(tab)?.count > beforeCount, { before: beforeCount, after: mirror(tab)?.count });
uid = snapshot(tab);
fp("click-element", { tabId: tab, uid: uid["Text input"], engine: "cdp" });
fp("press-key", { tabId: tab, key: "Enter", engine: "cdp" });
const cm = mirror(tab);
check("cdp press-key delivers real keyCode=13", cm?.lastKeyCode === 13, { keyCode: cm?.lastKeyCode, code: cm?.lastCode });

const passed = results.filter((r) => r.pass).length;
console.log(`\n==== ${passed}/${results.length} PASS ====`);
process.exit(passed === results.length ? 0 : 1);
