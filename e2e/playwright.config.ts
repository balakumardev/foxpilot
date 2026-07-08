import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.FIXTURE_PORT || 878);

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
