// Idle on purpose. probe.mjs attaches to this service worker over CDP and runs
// chrome.scripting / chrome.tabs / fetch snippets with Runtime.evaluate.
chrome.runtime.onInstalled.addListener(() => {});
// Lets probe.mjs wake this worker after the extension is reloaded (tabs.onCreated is a wake-up event).
chrome.tabs.onCreated.addListener(() => {});
self.PROBE_NAME = chrome.runtime.getManifest().name;
