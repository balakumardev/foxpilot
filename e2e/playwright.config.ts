import { defineConfig } from "@playwright/test";

// Default 8878 (NON-privileged): the fixture's historical default 878 is a
// privileged port (<1024) and fails with EACCES in sandboxed CI. Override with
// FIXTURE_PORT when 8878 is taken.
const PORT = Number(process.env.FIXTURE_PORT || 8878);
// The antd 4.x fixture runs alongside the spa-widgets one (default one port up)
// so a spec can drive real antd components without tearing the other down.
const ANTD_PORT = Number(process.env.ANTD_FIXTURE_PORT || 8879);

// Real-browser (Chromium) regression harness for the spa-widgets fixture. This
// project is deliberately outside the release-blocking test path (npm/jest/nx);
// run it locally with `npm run test:e2e`. `webServer` boots the zero-dep fixture
// server and tears it down when the run ends.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // 30s was sized for a chromium-only suite against the tiny spa-widgets
  // fixture. The suite now also runs every spec on Firefox and boots a real
  // antd 4 bundle, so on a modest box the parallel workers can push a cold
  // page load past 30s — the observed failures were all page.goto timing out
  // in beforeEach, never an assertion. A genuine hang still fails, just later.
  timeout: 60_000,
  fullyParallel: true,
  // One retry, and Playwright reports anything that needed it as "flaky" rather
  // than quietly passing it. Every flake observed here was page.goto exceeding
  // its budget on a saturated box (load average ~16 on 4 cores), i.e. the
  // machine, not the code — but a retry that has to be used still shows up in
  // the summary, so a genuine product flake cannot hide behind this.
  retries: 1,
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: [
    {
      command: `node ../test-fixtures/spa-widgets/server.mjs ${PORT}`,
      url: `http://localhost:${PORT}/`,
      reuseExistingServer: true,
      timeout: 10_000,
    },
    {
      command: `node ../test-fixtures/antd4/server.mjs ${ANTD_PORT}`,
      url: `http://localhost:${ANTD_PORT}/`,
      reuseExistingServer: true,
      timeout: 10_000,
    },
  ],
  // FoxPilot ships a Firefox extension first, and on Firefox there is no CDP /
  // trusted-input escape hatch — the synthetic isolated-world path is the ONLY
  // path. Injected-script regressions therefore have to be proven on Firefox,
  // not just Chromium, or a Firefox-only break ships green.
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
});
