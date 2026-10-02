// A post composer built the way web-component apps build one, with the
// surfaces the injected tools have to reach:
//   <cx-composer>         OPEN root; slots its light child <cx-composer-form>.
//   <cx-composer-form>    OPEN root; named slots "title" and "body".
//   <cx-textarea-input>   OPEN root holding the real title <textarea>, slotted
//                         through both roots above.
//   <cx-rte-composer>     OPEN root: a "Switch to Markdown" button, the slot for
//                         the rich-text editor (light DOM, a real Lexical
//                         editor), a placeholder drawn over it, and a hidden
//                         <cx-markdown-editor> (OPEN root) that nests
//                         <cx-md-textarea> (OPEN root) holding the Markdown
//                         <textarea>.
// Below it, two light-DOM contenteditables: a plain one (the browser's own
// editing, no framework) and a locked one that takes only trusted input and
// undoes any other change, the way an editor that refuses synthetic input
// behaves.
// #state is the oracle. It reports what the application holds: Lexical's own
// editor state, each component's value. Never the DOM a tool just wrote, and
// never a tool's reply.
(function () {
  var state = {
    ready: false,
    mode: "rich",
    title: "",
    body: "",
    markdown: "",
    plain: "",
    locked: "",
    lexicalError: null,
  };
  var out = document.getElementById("state");
  function commit() {
    out.textContent = JSON.stringify(state, null, 2);
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

  // Leaf components first, so containers upgrade with their parts defined.
  define(
    "cx-md-textarea",
    "<style>:host{display:block}" +
      "textarea{width:100%;min-height:120px;font:inherit;border:1px solid #888;border-radius:8px;padding:8px;box-sizing:border-box}</style>" +
      '<textarea aria-label="Markdown body" placeholder="Body text (optional)"></textarea>',
    function (host, root) {
      var ta = root.querySelector("textarea");
      ta.addEventListener("input", function () {
        state.markdown = ta.value;
        commit();
      });
    }
  );

  define(
    "cx-markdown-editor",
    "<style>:host{display:block}.md{padding:4px 0}</style>" +
      '<div class="md"><cx-md-textarea></cx-md-textarea></div>'
  );

  define(
    "cx-textarea-input",
    "<style>:host{display:block}" +
      "label{display:block;border:1px solid #888;border-radius:12px;padding:6px 12px}" +
      ".lbl{display:block;font-size:12px;color:#555}" +
      "textarea{display:block;width:100%;border:0;outline:0;resize:none;font:inherit;font-size:16px;background:transparent}" +
      ".counter{font-size:11px;color:#777;text-align:right}</style>" +
      '<label><span class="lbl">Title<span class="req">*</span></span>' +
      '<textarea name="title" rows="2" maxlength="300"></textarea></label>' +
      '<div class="counter">0/300</div>',
    function (host, root) {
      var ta = root.querySelector("textarea");
      var counter = root.querySelector(".counter");
      ta.addEventListener("input", function () {
        state.title = ta.value;
        counter.textContent = ta.value.length + "/300";
        commit();
      });
    }
  );

  define(
    "cx-rte-composer",
    "<style>:host{display:block}" +
      ".toolbar{display:flex;justify-content:flex-end;padding:4px 0}" +
      ".rte-wrap{position:relative;border:1px solid #888;border-radius:12px}" +
      "::slotted([slot=rte]){display:block;min-height:140px;padding:10px 12px;outline:0}" +
      ".placeholder{position:absolute;top:10px;left:12px;color:#888;pointer-events:none}" +
      ".rte-wrap[hidden],.placeholder[hidden],cx-markdown-editor[hidden]{display:none}</style>" +
      '<div class="toolbar"><button type="button" class="mode">Switch to Markdown</button></div>' +
      '<div class="rte-wrap"><slot name="rte"></slot><div class="placeholder">Body text (optional)</div></div>' +
      "<cx-markdown-editor hidden></cx-markdown-editor>",
    function (host, root) {
      var button = root.querySelector(".mode");
      var wrap = root.querySelector(".rte-wrap");
      var md = root.querySelector("cx-markdown-editor");
      var placeholder = root.querySelector(".placeholder");
      button.addEventListener("click", function () {
        var toMarkdown = state.mode === "rich";
        state.mode = toMarkdown ? "markdown" : "rich";
        wrap.hidden = toMarkdown;
        md.hidden = !toMarkdown;
        button.textContent = toMarkdown ? "Switch to Rich Text" : "Switch to Markdown";
        commit();
      });
      host.setEmpty = function (empty) {
        placeholder.hidden = !empty;
      };
    }
  );

  define(
    "cx-composer-form",
    "<style>:host{display:block}form{display:flex;flex-direction:column;gap:12px}</style>" +
      '<form><slot name="title"></slot><slot name="body"></slot></form>',
    function (host, root) {
      // Nothing in this fixture ever submits.
      root.querySelector("form").addEventListener("submit", function (e) {
        e.preventDefault();
      });
    }
  );

  define(
    "cx-composer",
    "<style>:host{display:block;max-width:720px}h2{font-size:18px;margin:0 0 8px}</style>" +
      "<h2>Create post</h2><slot></slot>"
  );

  // The rich-text body: a real Lexical editor on the light-DOM div.
  var body = document.getElementById("post-body");
  var rte = document.getElementById("rte");
  var L = window.Lexical;
  if (L) {
    var editor = L.createEditor({
      namespace: "composer",
      nodes: [L.HeadingNode, L.QuoteNode],
      onError: function (e) {
        state.lexicalError = String(e);
        commit();
      },
    });
    editor.setRootElement(rte);
    L.registerRichText(editor);
    editor.registerUpdateListener(function (p) {
      p.editorState.read(function () {
        state.body = L.$getRoot().getTextContent();
      });
      body.setEmpty(state.body.length === 0);
      commit();
    });
    editor.update(function () {
      var r = L.$getRoot();
      if (r.getFirstChild() === null) {
        r.append(L.$createParagraphNode());
      }
    });
    state.ready = true;
  }

  // Plain contenteditable: whatever the browser's editing leaves in it.
  var plain = document.getElementById("plain-ce");
  plain.addEventListener("input", function () {
    state.plain = plain.textContent;
    commit();
  });

  // Locked contenteditable: a trusted beforeinput lets the browser edit; any
  // other change to its DOM is undone.
  var locked = document.getElementById("locked-ce");
  var trustedEdit = false;
  locked.addEventListener("beforeinput", function (e) {
    if (!e.isTrusted) {
      e.preventDefault();
      return;
    }
    trustedEdit = true;
  });
  locked.addEventListener("input", function () {
    if (trustedEdit) {
      trustedEdit = false;
      state.locked = locked.textContent;
      commit();
    }
  });
  new MutationObserver(function () {
    if (!trustedEdit && locked.textContent !== state.locked) {
      locked.textContent = state.locked;
    }
  }).observe(locked, { childList: true, characterData: true, subtree: true });

  commit();
})();
