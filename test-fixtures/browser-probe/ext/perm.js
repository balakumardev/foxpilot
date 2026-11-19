// Extension page used by case 2: a trusted click here calls chrome.permissions.request.
window.__permResult = "idle";
document.getElementById("grant").addEventListener("click", (ev) => {
  window.__clickIsTrusted = ev.isTrusted;
  window.__userActivationActive = navigator.userActivation.isActive;
  window.__permResult = "pending";
  chrome.permissions.request({ origins: ["<all_urls>"] }).then(
    (granted) => {
      window.__permResult = "resolved:" + granted;
    },
    (err) => {
      window.__permResult = "rejected:" + (err && err.message);
    },
  );
});
