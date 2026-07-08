import { defineConfig } from "@playwright/test";

// Default 8878 (NON-privileged): the fixture's historical default 878 is a
// privileged port (<1024) and fails with EACCES in sandboxed CI. Override with
// FIXTURE_PORT when 8878 is taken.
const PORT = Number(process.env.FIXTURE_PORT || 8878);

// Real-browser (Chromium) regression harness for the spa-widgets fixture. This
// project is deliberately outside the release-blocking test path (npm/jest/nx);
// run it locally with `npm run test:e2e`. `webServer` boots the zero-dep fixture
// server and tears it down when the run ends.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  fullyParallel: true,
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `node ../test-fixtures/spa-widgets/server.mjs ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 10_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
