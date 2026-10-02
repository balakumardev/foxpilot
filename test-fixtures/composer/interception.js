// Click-interception surfaces. Every control counts its own clicks in the
// light-DOM #state oracle; links carry https hrefs and a router-style handler
// that calls preventDefault, so a test click never leaves the fixture.
//   <cx-tooltip>/<cx-popper>  the rpl-tooltip / rpl-popper shape: the anchor
//                         link is light DOM slotted through the tooltip's root
//                         into the popper's "anchor" slot; the popper draws a
//                         popup and a safe-area span in its own root (opened
//                         on pointerover, below the anchor, never over it).
//   <cx-header-buttons>   the community header buttons, drawn in an open root:
//                         a "Create Post" link whose centre is its own
//                         span.flex, and a <cx-join-button> (open root).
//   #create-post-light    the same link in light DOM.
//   <cx-button>           a button in an open root whose label is a slotted
//                         light-DOM span.flex.
//   #toast                a light-DOM span.flex toast laid over #covered-btn.
//   <cx-scrim-card>       draws a scrim (with a span.flex) in its own root over
//                         its slotted #scrim-btn.
(function () {
  var state = {
    clicks: {
      headerCreate: 0,
      createPost: 0,
      join: 0,
      createPostLight: 0,
      cxCreate: 0,
      coveredBtn: 0,
      toast: 0,
      scrimBtn: 0,
      scrim: 0,
    },
    tooltipOpen: false,
    // Innermost node the last click reached (composedPath()[0]).
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
    var cls = (node.getAttribute("class") || "").trim().split(/\s+/)[0];
    return node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") + (cls ? "." + cls : "");
  }
  document.addEventListener(
    "click",
    function (e) {
      var path = e.composedPath ? e.composedPath() : [];
      state.lastClick = describe(path[0] || e.target);
      commit();
    },
    true
  );
  function counts(el, key, isLink) {
    el.addEventListener("click", function (e) {
      if (isLink) {
        e.preventDefault();
      }
      state.clicks[key]++;
      commit();
    });
  }
  function define(name, html, setup) {
    customElements.define(
      name,
      class extends HTMLElement {
        constructor() {
          super();
          var root = this.attachShadow({ mode: "open" });
          root.innerHTML = html;
          if (setup) {
            setup(this, root);
          }
        }
      }
    );
  }
  var FLEX =
    ".flex{display:flex}.items-center{align-items:center}.justify-center{justify-content:center}" +
    ".gap-xs{gap:4px}.gap-sm{gap:8px}.mr-xs{margin-right:4px}" +
    "a.button,button{display:inline-flex;align-items:center;padding:8px 14px;border:1px solid #888;" +
    "border-radius:999px;color:#111;text-decoration:none;background:#f4f4f4;font:inherit}";

  define(
    "cx-popper",
    "<style>:host{display:inline-block;position:relative}" +
      ".popup{position:absolute;top:calc(100% + 8px);left:0;white-space:nowrap;background:#222;color:#fff;padding:4px 8px;border-radius:6px}" +
      ".popup-safe-area{position:absolute;left:0;right:0;top:100%;height:8px}" +
      ".popup[hidden],.popup-safe-area[hidden]{display:none}</style>" +
      '<slot name="anchor"></slot><span class="popup-safe-area" hidden></span>' +
      '<div class="popup" hidden><slot></slot></div>',
    function (host, root) {
      var popup = root.querySelector(".popup");
      var safe = root.querySelector(".popup-safe-area");
      host.setOpen = function (open) {
        popup.hidden = !open;
        safe.hidden = !open;
      };
    }
  );

  define(
    "cx-tooltip",
    "<style>:host{display:inline-block}</style>" +
      '<cx-popper><slot slot="anchor"></slot>' +
      '<div class="tooltip-body"><slot name="content"></slot></div></cx-popper>',
    function (host, root) {
      var popper = root.querySelector("cx-popper");
      host.addEventListener("pointerover", function () {
        popper.setOpen(true);
        state.tooltipOpen = true;
        commit();
      });
      host.addEventListener("pointerout", function (e) {
        if (e.relatedTarget && host.contains(e.relatedTarget)) {
          return;
        }
        popper.setOpen(false);
        state.tooltipOpen = false;
        commit();
      });
    }
  );

  define(
    "cx-join-button",
    "<style>:host{display:inline-block}" + FLEX + "</style>" +
      '<button type="button" class="button-primary join-btn">Join</button>',
    function (host, root) {
      counts(root.querySelector("button"), "join", false);
    }
  );

  define(
    "cx-header-buttons",
    "<style>:host{display:inline-block}" + FLEX + "</style>" +
      '<div class="flex items-center gap-sm">' +
      '<a id="create-post" class="button" href="https://example.com/r/fixture/submit">' +
      '<span class="flex items-center justify-center"><span class="flex mr-xs">+</span>' +
      '<span class="flex items-center gap-xs">Create Post</span></span></a>' +
      "<cx-join-button></cx-join-button></div>",
    function (host, root) {
      counts(root.getElementById("create-post"), "createPost", true);
    }
  );

  define(
    "cx-button",
    "<style>:host{display:inline-block}" + FLEX + "</style>" +
      '<button type="button" class="btn"><slot></slot></button>',
    function (host, root) {
      counts(root.querySelector("button"), "cxCreate", false);
    }
  );

  define(
    "cx-scrim-card",
    "<style>:host{display:inline-block}" + FLEX +
      ".card{position:relative;display:inline-block;padding:4px}" +
      ".scrim{position:absolute;inset:0;background:rgba(255,255,255,0.75)}" +
      ".scrim>span{height:100%;align-items:center;justify-content:center}</style>" +
      '<div class="card"><slot></slot><div class="scrim"><span class="flex">Saving</span></div></div>',
    function (host, root) {
      counts(root.querySelector(".scrim"), "scrim", false);
    }
  );

  counts(document.getElementById("header-create"), "headerCreate", true);
  counts(document.getElementById("create-post-light"), "createPostLight", true);
  counts(document.getElementById("covered-btn"), "coveredBtn", false);
  counts(document.getElementById("toast"), "toast", false);
  counts(document.getElementById("scrim-btn"), "scrimBtn", false);
  document.getElementById("home-link").addEventListener("click", function (e) {
    e.preventDefault();
  });
  commit();
})();
