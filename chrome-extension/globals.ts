import browser from "webextension-polyfill";

// Make browser available globally for all modules
if (typeof globalThis !== "undefined") {
  (globalThis as any).browser = browser;
}
