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
})();
