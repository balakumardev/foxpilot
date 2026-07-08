// Renders the four Cloudflare-dashboard hazards for the injected-tool tests:
// (a) a react-select-style searchable PORTAL dropdown, (b) a fixed full-screen
// OneTrust-like consent overlay that RE-MOUNTS on every pushState route change,
// (c) several identically-labelled "Use template" buttons inside titled cards,
// (d) pushState SPA routing where /templates deliberately lands on /home.
(function () {
  var COUNTRIES = ["France", "Germany", "India", "Japan", "Spain", "United States"];

  // ---- (c) Repeated "Use template" buttons inside titled cards ----
  function renderCards(container) {
    ["Starter", "Pro", "Enterprise"].forEach(function (title) {
      var card = document.createElement("section");
      card.className = "card";
      var h = document.createElement("h3");
      h.textContent = title;
      var p = document.createElement("p");
      p.textContent = title + " plan template.";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Use template"; // identical label across every card
      btn.addEventListener("click", function () {
        document.getElementById("log").textContent = "Chose " + title;
      });
      card.appendChild(h);
      card.appendChild(p);
      card.appendChild(btn);
      container.appendChild(card);
    });
  }

  // ---- (a) react-select-style searchable PORTAL dropdown ----
  function renderSelect(container) {
    var control = document.createElement("div");
    control.id = "country-select";
    control.className = "rs__control";
    control.setAttribute("role", "combobox");
    control.setAttribute("aria-expanded", "false");
    control.setAttribute("aria-label", "Country");
    control.tabIndex = 0;

    var placeholder = document.createElement("div");
    placeholder.className = "rs__placeholder";
    placeholder.textContent = "Select...";

    var single = document.createElement("div");
    single.className = "rs__single-value";
    single.style.display = "none"; // revealed once a value is chosen

    control.appendChild(placeholder);
    control.appendChild(single);
    container.appendChild(control);

    var menu = null;
    function closeMenu() {
      if (menu) { menu.remove(); menu = null; }
      control.setAttribute("aria-expanded", "false");
    }
    function choose(value) {
      single.textContent = value;
      single.style.display = "";
      placeholder.style.display = "none";
      closeMenu();
    }
    function openMenu() {
      if (menu) return;
      control.setAttribute("aria-expanded", "true");
      // Portal: appended to <body>, NOT inside the control — react-select shape.
      menu = document.createElement("div");
      menu.className = "rs__menu";
      menu.setAttribute("role", "listbox");
      var search = document.createElement("input");
      search.className = "rs__input";
      search.type = "text";
      search.setAttribute("aria-label", "Search country");
      var list = document.createElement("div");
      list.className = "rs__options";
      menu.appendChild(search);
      menu.appendChild(list);
      function paint(filter) {
        list.textContent = "";
        COUNTRIES.filter(function (c) {
          return c.toLowerCase().indexOf((filter || "").toLowerCase()) !== -1;
        }).forEach(function (c) {
          var opt = document.createElement("div");
          opt.setAttribute("role", "option");
          opt.className = "rs__option";
          opt.textContent = c;
          opt.addEventListener("click", function () { choose(c); });
          list.appendChild(opt);
        });
      }
      paint("");
      search.addEventListener("input", function () { paint(search.value); });
      var r = control.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.left = r.left + "px";
      menu.style.top = r.bottom + "px";
      menu.style.width = Math.max(r.width, 220) + "px";
      document.body.appendChild(menu);
      search.focus();
    }
    control.addEventListener("click", function () {
      if (menu) closeMenu(); else openMenu();
    });
  }

  // ---- (b) OneTrust-like full-screen overlay; re-mounts on every route ----
  function mountOverlay() {
    if (document.getElementById("onetrust-banner-sdk")) return;
    var overlay = document.createElement("div");
    overlay.id = "onetrust-banner-sdk";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    var msg = document.createElement("p");
    msg.textContent = "We use cookies.";
    var reject = document.createElement("button");
    reject.id = "onetrust-reject-all-handler";
    reject.type = "button";
    reject.textContent = "Reject All";
    reject.addEventListener("click", function () { overlay.remove(); });
    var accept = document.createElement("button");
    accept.id = "onetrust-accept-btn-handler";
    accept.type = "button";
    accept.textContent = "Accept All";
    accept.addEventListener("click", function () { overlay.remove(); });
    overlay.appendChild(msg);
    overlay.appendChild(reject);
    overlay.appendChild(accept);
    document.body.appendChild(overlay);
  }

  // ---- (d) pushState routing; /templates deliberately lands on /home ----
  function renderRoute() {
    var view = document.getElementById("view");
    view.textContent = "";
    var title = document.createElement("h2");
    title.textContent = "Route: " + location.pathname;
    view.appendChild(title);
    renderCards(view);
    renderSelect(view);
    mountOverlay(); // every (re)render re-mounts the consent overlay
  }
  function navigate(to) {
    // The router intercepts /templates and "lands elsewhere" (/home) — the
    // navigate-tab false-success hazard.
    var landing = to === "/templates" ? "/home" : to;
    history.pushState({}, "", landing);
    renderRoute();
  }

  var root = document.getElementById("app");
  root.innerHTML =
    '<nav id="nav">' +
    '<a href="#" data-to="/home" id="link-home">Home</a>' +
    '<a href="#" data-to="/templates" id="link-templates">Templates</a>' +
    "</nav>" +
    '<main id="view"></main>' +
    '<div id="log"></div>';
  Array.prototype.forEach.call(
    root.querySelectorAll("a[data-to]"),
    function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        navigate(a.getAttribute("data-to"));
      });
    }
  );
  window.addEventListener("popstate", renderRoute);
  renderRoute();
})();
