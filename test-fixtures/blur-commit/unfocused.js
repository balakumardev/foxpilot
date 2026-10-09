// Loaded first, before every other script. With ?unfocused=1 the page behaves
// like a document WITHOUT system focus (a background tab, or a browser window
// behind another app): the browser still moves document.activeElement on
// focus() and blur(), but delivers no focus, blur, focusin or focusout. The
// browser's own (trusted) focus events are stopped here, at the window in the
// capture phase, ahead of every listener the page or FoxPilot adds later, so
// none of them sees one. Events a script dispatches itself (isTrusted false)
// pass. The e2e harness uses this on Firefox, where Playwright always emulates
// a focused page; on Chromium it can also run against a real unfocused window.
(function () {
  if (!/[?&]unfocused=1(?:&|$)/.test(location.search)) {
    return;
  }
  window.__unfocused = true;
  ["focus", "blur", "focusin", "focusout"].forEach(function (type) {
    window.addEventListener(
      type,
      function (e) {
        if (e.isTrusted) {
          e.stopImmediatePropagation();
        }
      },
      true
    );
  });
})();
