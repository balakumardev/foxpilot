// Renders the shadow-DOM surfaces the injected tools have to see through, in the
// shape of a web-components admin console (amp-* hosts):
//   <amp-nav>     OPEN root: <nav> with https links, a text button, an icon-only
//                 aria-label button, an <h2>, and a NESTED <amp-account-menu>
//                 with its own open root.
//   <amp-card>    OPEN root with a named slot (assigned), a default slot, a slot
//                 whose fallback content renders, and its own button. One light
//                 child names a slot that does not exist, so it never renders.
//   <amp-search>  OPEN root: an input named only by a <label for> inside the same
//                 root, a native <select>, and an inner scroll container whose
//                 last item is a button far below the fold.
//   <amp-secret>  CLOSED root: reachable from the extension's isolated world
//                 (openOrClosedShadowRoot / chrome.dom), never from the page.
//   <amp-hidden>  display:none host whose button must never be listed.
//   <amp-footer>  OPEN root with footer links.
// Every listener feeds the light-DOM #state oracle, so tests assert what the page
// actually saw rather than what a tool replied. Oracle keys are camelCase on
// purpose: no textContains needle or page-text assertion ("Users and Access",
// "Privacy", ...) can match the oracle's own text. Links carry absolute https
// hrefs (get-tab-web-content keeps only those) and a router-style handler that
// calls preventDefault, so a test click never navigates off the fixture.
(function () {
  var state = {
    clicks: {
      appsLink: 0,
      businessLink: 0,
      usersAccess: 0,
      accountMenu: 0,
      signOut: 0,
      slottedLink: 0,
      fallbackButton: 0,
      cardAction: 0,
      unassigned: 0,
      loadMore: 0,
      closedButton: 0,
      hiddenHostButton: 0,
      lightButton: 0,
      privacyLink: 0,
      termsLink: 0,
    },
    hovers: { accountMenu: 0 },
    search: "",
    lastKey: "",
    platform: "ios",
    resultsScrollTop: 0,
    loadMoreVisible: false,
    // Innermost node the last click actually hit (see the capture listener).
    lastClick: null,
  };
  var out = document.getElementById("state");
  function commit() {
    out.textContent = JSON.stringify(state, null, 2);
  }
  function describe(node) {
    if (!node || !node.tagName) {
      return String(node);
    }
    return node.tagName.toLowerCase() + (node.id ? "#" + node.id : "");
  }
  // composedPath()[0] pierces OPEN roots, so a failing test can say where a
  // click really landed — e.g. on a host instead of the control inside it.
  document.addEventListener(
    "click",
    function (e) {
      state.lastClick = describe(e.composedPath()[0]);
      commit();
    },
    true
  );

  function countClicks(el, key) {
    el.addEventListener("click", function () {
      state.clicks[key] += 1;
      commit();
    });
  }
  function routerLink(a, key) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      state.clicks[key] += 1;
      commit();
    });
  }

  // A custom element whose constructor attaches a `mode` shadow root, fills it
  // with `html` and wires it. The constructor runs exactly once per element (at
  // upgrade for the ones already in the page), so the closed root needs no
  // re-entry guard and its reference never leaves this closure.
  function define(name, mode, html, wire) {
    customElements.define(
      name,
      class extends HTMLElement {
        constructor() {
          super();
          var root = this.attachShadow({ mode: mode });
          root.innerHTML = html;
          wire(root);
        }
      }
    );
  }

  // Defined before <amp-nav>, whose root creates it.
  define(
    "amp-account-menu",
    "open",
    "<style>:host { display: inline-block; }</style>" +
      '<button type="button" id="sign-out">Sign Out</button>',
    function (root) {
      countClicks(root.getElementById("sign-out"), "signOut");
    }
  );

  define(
    "amp-nav",
    "open",
    "<style>" +
      ":host { display: block; border-bottom: 1px solid #ddd; }" +
      "nav { display: flex; align-items: center; gap: 12px; padding: 8px 0; }" +
      "h2 { font-size: 16px; margin: 0 8px 0 0; }" +
      "</style>" +
      '<nav aria-label="Primary">' +
      "<h2>Developer Portal</h2>" +
      '<a id="apps-link" href="https://example.com/apps">Apps</a>' +
      '<a id="business-link" href="https://example.com/business">Business</a>' +
      '<button type="button" id="users-access">Users and Access</button>' +
      '<button type="button" id="account-menu" aria-label="Account menu">' +
      '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<circle cx="8" cy="8" r="7" fill="currentColor"></circle></svg>' +
      "</button>" +
      "<amp-account-menu></amp-account-menu>" +
      "</nav>",
    function (root) {
      routerLink(root.getElementById("apps-link"), "appsLink");
      routerLink(root.getElementById("business-link"), "businessLink");
      countClicks(root.getElementById("users-access"), "usersAccess");
      var account = root.getElementById("account-menu");
      countClicks(account, "accountMenu");
      account.addEventListener("mouseenter", function () {
        state.hovers.accountMenu += 1;
        commit();
      });
    }
  );

  define(
    "amp-card",
    "open",
    "<style>" +
      ":host { display: block; border: 1px solid #ccc; border-radius: 8px; padding: 12px; margin: 12px 0; }" +
      ".title { font-weight: 600; margin-bottom: 6px; }" +
      ".body, .empty { margin: 6px 0; }" +
      "</style>" +
      '<div class="title"><slot name="title">Fallback title</slot></div>' +
      '<div class="body"><slot></slot></div>' +
      '<div class="empty"><slot name="empty">' +
      '<button type="button" id="fallback-button">Fallback button</button>' +
      "</slot></div>" +
      '<button type="button" id="card-action">Card action</button>',
    function (root) {
      countClicks(root.getElementById("fallback-button"), "fallbackButton");
      countClicks(root.getElementById("card-action"), "cardAction");
    }
  );

  var resultRows = "";
  for (var i = 1; i <= 30; i++) {
    resultRows += '<div class="row">Result ' + i + "</div>";
  }
  define(
    "amp-search",
    "open",
    "<style>" +
      ":host { display: block; margin: 12px 0; }" +
      "select { margin-left: 8px; }" +
      ".results { height: 120px; overflow: auto; border: 1px solid #999; border-radius: 6px; margin-top: 8px; padding: 4px; }" +
      ".row { padding: 6px 4px; border-bottom: 1px dashed #ddd; }" +
      "</style>" +
      // Named ONLY by this label: no aria-label / placeholder / title fallback.
      '<label for="q">Search apps</label> <input id="q" type="search">' +
      '<select id="platform" aria-label="Platform">' +
      '<option value="ios">iOS</option>' +
      '<option value="macos">macOS</option>' +
      '<option value="tvos">tvOS</option>' +
      "</select>" +
      '<div class="results" id="results">' +
      resultRows +
      '<button type="button" id="load-more">Load more results</button>' +
      "</div>",
    function (root) {
      var q = root.getElementById("q");
      q.addEventListener("input", function () {
        state.search = q.value;
        commit();
      });
      q.addEventListener("keydown", function (e) {
        state.lastKey = e.key;
        commit();
      });
      var platform = root.getElementById("platform");
      platform.addEventListener("change", function () {
        state.platform = platform.value;
        commit();
      });
      var results = root.getElementById("results");
      var more = root.getElementById("load-more");
      countClicks(more, "loadMore");
      // Whether the far-below button is inside the container's visible box —
      // the scroll-into-view oracle, re-measured on every container scroll.
      function measure() {
        var c = results.getBoundingClientRect();
        var b = more.getBoundingClientRect();
        state.resultsScrollTop = Math.round(results.scrollTop);
        state.loadMoreVisible = b.top >= c.top && b.bottom <= c.bottom;
        commit();
      }
      results.addEventListener("scroll", measure);
      measure();
    }
  );

  define(
    "amp-secret",
    "closed",
    "<style>:host { display: block; margin: 12px 0; }</style>" +
      '<button type="button" id="closed-button">Closed Button</button>',
    function (root) {
      countClicks(root.getElementById("closed-button"), "closedButton");
    }
  );

  define(
    "amp-hidden",
    "open",
    '<button type="button" id="hidden-host-button">Hidden Host Button</button>',
    function (root) {
      countClicks(root.getElementById("hidden-host-button"), "hiddenHostButton");
    }
  );

  define(
    "amp-footer",
    "open",
    "<style>" +
      ":host { display: block; border-top: 1px solid #ddd; padding: 8px 0; margin-bottom: 12px; }" +
      "a { margin-right: 12px; }" +
      "</style>" +
      '<div class="links">' +
      '<a id="privacy-link" href="https://example.com/privacy">Privacy</a>' +
      '<a id="terms-link" href="https://example.com/terms">Terms</a>' +
      "</div>",
    function (root) {
      routerLink(root.getElementById("privacy-link"), "privacyLink");
      routerLink(root.getElementById("terms-link"), "termsLink");
    }
  );

  // Light-DOM controls (the two <amp-card> children are projected / unassigned).
  countClicks(document.getElementById("light-button"), "lightButton");
  routerLink(document.getElementById("slotted-link"), "slottedLink");
  countClicks(document.getElementById("unassigned"), "unassigned");

  commit();
})();
