// Builds the parts a strict-CSP custom-React SPA would render at runtime:
// a large sidebar list, a tall inner-scroll panel, and a click handler on
// the role-less "Open" card. Inline scripts are blocked by CSP, so this
// external same-origin file is the only script that runs.
(function () {
  var sidebar = document.getElementById("sidebar");
  for (var i = 1; i <= 700; i++) {
    var item = document.createElement("div");
    item.className = "item";
    item.textContent = "Sidebar item " + i;
    sidebar.appendChild(item);
  }

  var inner = document.getElementById("inner-scroll");
  for (var r = 1; r <= 60; r++) {
    var row = document.createElement("div");
    row.className = "row";
    row.textContent = "Inner row " + r + " — scroll me, not the window";
    inner.appendChild(row);
  }

  var card = document.getElementById("open-card");
  var log = document.getElementById("log");
  // Handler attached via addEventListener — no onclick attribute, no role,
  // no tabindex: invisible to a semantic-only snapshot, visible only via
  // cursor:pointer or a textContains/selector query.
  card.addEventListener("click", function () {
    log.textContent = "Opened at " + new Date().toISOString();
  });

  // Bug-2 regression target: a real <button> whose click navigates cross-origin.
  // The navigation tears down this content-script world before the input ack can
  // return, so it exercises the background-side nav-race — click-element /
  // click-at / type-at must resolve { ok:true, navigated:true } instead of
  // hanging until the broker times out. Semantic <button> (implicit role +
  // accessible name) so take-snapshot surfaces it and click-element can target
  // its uid.
  var mainPanel = document.getElementById("main-panel");
  var continueBtn = document.createElement("button");
  continueBtn.id = "continue-btn";
  continueBtn.textContent = "Continue to Example";
  continueBtn.addEventListener("click", function () {
    window.location.href = "https://example.com/";
  });
  mainPanel.appendChild(continueBtn);
})();
