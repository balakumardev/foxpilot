(() => {
  // chrome-extension/injected/action-script.ts
  function performInputAction(doc, args) {
    const UID_ATTR = "data-bcmcp-uid";
    try {
      let bcmcpSig2 = function(el) {
        var role = el.getAttribute && (el.getAttribute("role") || "");
        var name = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("data-testid") || "") || "";
        var t = (el.tagName || "") + "|" + role + "|" + (el.id || "") + "|" + name;
        var h = 0;
        for (var i = 0; i < t.length; i++) {
          h = (h << 5) - h + t.charCodeAt(i) | 0;
        }
        return (h >>> 0).toString(36);
      }, resolve2 = function(uid) {
        const node = doc.querySelector("[" + UID_ATTR + '="' + uid + '"]');
        if (!node) {
          return null;
        }
        const sig = node.getAttribute("data-bcmcp-sig");
        if (sig && bcmcpSig2(node) !== sig) {
          return null;
        }
        return node;
      }, notFound2 = function(uid) {
        return {
          ok: false,
          error: "Element uid '" + uid + "' not found \u2014 take a fresh snapshot (uids are reassigned each snapshot)."
        };
      }, scrollTo2 = function(el) {
        try {
          el.scrollIntoView?.({
            block: "center"
          });
        } catch (e) {
        }
      }, elementCenter2 = function(el) {
        try {
          const r = el.getBoundingClientRect();
          if (r && (r.width || r.height || r.left || r.top)) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        } catch (e) {
        }
        return { x: 0, y: 0 };
      }, mouseEvt2 = function(type, opts) {
        const o = opts || {};
        const x = typeof o.x === "number" ? o.x : 0;
        const y = typeof o.y === "number" ? o.y : 0;
        const isEnter = type === "mouseenter" || type === "mouseleave" || type === "pointerenter" || type === "pointerleave";
        const init = {
          bubbles: !isEnter,
          cancelable: true,
          composed: true,
          view: win,
          button: 0,
          buttons: typeof o.buttons === "number" ? o.buttons : 0,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y
        };
        const PE = win && win.PointerEvent;
        if (type.indexOf("pointer") === 0 && typeof PE === "function") {
          const pinit = init;
          pinit.pointerId = 1;
          pinit.pointerType = "mouse";
          pinit.isPrimary = true;
          return new PE(type, pinit);
        }
        return new MouseEvent(type, init);
      }, dispatchClickSequence2 = function(el, doubleClick) {
        const c = elementCenter2(el);
        el.dispatchEvent(mouseEvt2("pointerover", { x: c.x, y: c.y }));
        el.dispatchEvent(mouseEvt2("pointerenter", { x: c.x, y: c.y }));
        el.dispatchEvent(mouseEvt2("pointermove", { x: c.x, y: c.y }));
        el.dispatchEvent(mouseEvt2("pointerdown", { x: c.x, y: c.y, buttons: 1 }));
        el.dispatchEvent(mouseEvt2("mousedown", { x: c.x, y: c.y, buttons: 1 }));
        try {
          el.focus?.();
        } catch (e) {
        }
        el.dispatchEvent(mouseEvt2("pointerup", { x: c.x, y: c.y, buttons: 0 }));
        el.dispatchEvent(mouseEvt2("mouseup", { x: c.x, y: c.y, buttons: 0 }));
        try {
          el.click?.();
        } catch (e) {
        }
        if (doubleClick) {
          el.dispatchEvent(mouseEvt2("dblclick", { x: c.x, y: c.y }));
        }
      }, classifyHit2 = function(target, topmost) {
        if (!target || !topmost) {
          return "self";
        }
        if (topmost === target) {
          return "self";
        }
        if (target.contains(topmost)) {
          return "descendant";
        }
        if (topmost.contains(target)) {
          return "ancestor";
        }
        return "unrelated";
      }, describeIntercept2 = function(el) {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? el.id : void 0;
        const clsAttr = (el.getAttribute("class") || "").replace(/\s+/g, " ").trim();
        const classes = clsAttr ? clsAttr : void 0;
        const role = el.getAttribute("role") || void 0;
        const ariaLabel = el.getAttribute("aria-label");
        const rawName = ariaLabel || (el.textContent || "").replace(/\s+/g, " ").trim();
        const name = rawName ? rawName.slice(0, 80) : void 0;
        return {
          tag,
          ...id ? { id } : {},
          ...classes ? { classes } : {},
          ...role ? { role } : {},
          ...name ? { name } : {}
        };
      }, selectorFor2 = function(desc) {
        if (desc.id) {
          return "#" + desc.id;
        }
        if (desc.classes) {
          return desc.tag + "." + desc.classes.split(" ")[0];
        }
        return desc.tag;
      }, isCheckable2 = function(el) {
        if (el.tagName !== "INPUT") {
          return false;
        }
        const type = (el.getAttribute("type") || "").toLowerCase();
        return type === "checkbox" || type === "radio";
      }, truthyValue2 = function(value) {
        return value === "true" || value === "on" || value === "1";
      }, nativeSetValue2 = function(el, value) {
        const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        const setter = descriptor && descriptor.set;
        if (setter) {
          setter.call(el, value);
        } else {
          el.value = value;
        }
      }, focusSafely2 = function(el) {
        try {
          el.focus?.();
        } catch (e) {
        }
      }, fillElement2 = function(el, value) {
        scrollTo2(el);
        if (el.tagName === "SELECT") {
          const sel = el;
          const opts = sel.options;
          const wantNorm = (value || "").replace(/\s+/g, " ").trim();
          let chosen = null;
          for (let i = 0; i < opts.length; i++) {
            if (opts[i].value === value) {
              chosen = opts[i];
              break;
            }
          }
          if (!chosen) {
            for (let j = 0; j < opts.length; j++) {
              const o = opts[j];
              const t = (o.textContent || "").replace(/\s+/g, " ").trim();
              const lbl = (o.getAttribute("label") || "").replace(/\s+/g, " ").trim();
              if (t === wantNorm || lbl === wantNorm) {
                chosen = o;
                break;
              }
            }
          }
          if (!chosen) {
            return {
              ok: false,
              error: 'No <option> matching "' + value + '" in the <select> (matched neither an option value nor its visible text).'
            };
          }
          const proto = win.HTMLSelectElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
          const setter = descriptor && descriptor.set;
          if (setter) {
            setter.call(el, chosen.value);
          } else {
            el.value = chosen.value;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        }
        if (isCheckable2(el)) {
          const target = truthyValue2(value);
          const isRadio = (el.getAttribute("type") || "").toLowerCase() === "radio";
          const cur = el.checked === true;
          if (isRadio) {
            if (target && !cur) {
              dispatchClickSequence2(el);
            }
          } else if (cur !== target) {
            dispatchClickSequence2(el);
          }
          return { ok: true };
        }
        focusSafely2(el);
        nativeSetValue2(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }, keyInfo2 = function(key) {
        const named = {
          Enter: ["Enter", 13],
          Tab: ["Tab", 9],
          Escape: ["Escape", 27],
          Esc: ["Escape", 27],
          Backspace: ["Backspace", 8],
          Delete: ["Delete", 46],
          ArrowUp: ["ArrowUp", 38],
          ArrowDown: ["ArrowDown", 40],
          ArrowLeft: ["ArrowLeft", 37],
          ArrowRight: ["ArrowRight", 39],
          Home: ["Home", 36],
          End: ["End", 35],
          PageUp: ["PageUp", 33],
          PageDown: ["PageDown", 34],
          " ": ["Space", 32],
          Spacebar: ["Space", 32]
        };
        if (named[key]) {
          return { code: named[key][0], keyCode: named[key][1] };
        }
        if (key && key.length === 1) {
          const c = key;
          if (c >= "a" && c <= "z") {
            return { code: "Key" + c.toUpperCase(), keyCode: c.toUpperCase().charCodeAt(0) };
          }
          if (c >= "A" && c <= "Z") {
            return { code: "Key" + c, keyCode: c.charCodeAt(0) };
          }
          if (c >= "0" && c <= "9") {
            return { code: "Digit" + c, keyCode: c.charCodeAt(0) };
          }
          return { code: "", keyCode: c.charCodeAt(0) };
        }
        return { code: "", keyCode: 0 };
      }, isPrintableKey2 = function(key) {
        return !!key && key.length === 1;
      }, keyEvt2 = function(type, key, modifiers) {
        const mods = modifiers || {};
        const info = keyInfo2(key);
        const ev = new KeyboardEvent(type, {
          key,
          code: info.code,
          bubbles: true,
          cancelable: true,
          composed: true,
          view: win,
          ctrlKey: !!mods.ctrl,
          shiftKey: !!mods.shift,
          altKey: !!mods.alt,
          metaKey: !!mods.meta
        });
        try {
          Object.defineProperty(ev, "keyCode", {
            get: function() {
              return info.keyCode;
            }
          });
          Object.defineProperty(ev, "which", {
            get: function() {
              return info.keyCode;
            }
          });
        } catch (e) {
        }
        return ev;
      }, contentEditableHost2 = function(el) {
        if (el.isContentEditable === true) {
          return true;
        }
        const ce = el.getAttribute("contenteditable");
        return ce === "" || ce === "true" || ce === "plaintext-only";
      }, insertIntoContentEditable2 = function(el, text) {
        const IE = win && win.InputEvent;
        let beforeEv;
        if (typeof IE === "function") {
          beforeEv = new IE("beforeinput", {
            inputType: "insertText",
            data: text,
            bubbles: true,
            cancelable: true,
            composed: true
          });
        } else {
          beforeEv = new Event("beforeinput", { bubbles: true, cancelable: true });
          try {
            Object.defineProperty(beforeEv, "inputType", { value: "insertText" });
            Object.defineProperty(beforeEv, "data", { value: text });
          } catch (e) {
          }
        }
        const notPrevented = el.dispatchEvent(beforeEv);
        if (notPrevented) {
          let inserted = false;
          const doExec = doc.execCommand;
          if (typeof doExec === "function") {
            try {
              inserted = doExec.call(doc, "insertText", false, text);
            } catch (e) {
              inserted = false;
            }
          }
          if (!inserted) {
            el.textContent = (el.textContent || "") + text;
          }
          let inputEv;
          if (typeof IE === "function") {
            inputEv = new IE("input", {
              inputType: "insertText",
              data: text,
              bubbles: true,
              composed: true
            });
          } else {
            inputEv = new Event("input", { bubbles: true });
            try {
              Object.defineProperty(inputEv, "inputType", { value: "insertText" });
              Object.defineProperty(inputEv, "data", { value: text });
            } catch (e) {
            }
          }
          el.dispatchEvent(inputEv);
        }
      };
      var bcmcpSig = bcmcpSig2, resolve = resolve2, notFound = notFound2, scrollTo = scrollTo2, elementCenter = elementCenter2, mouseEvt = mouseEvt2, dispatchClickSequence = dispatchClickSequence2, classifyHit = classifyHit2, describeIntercept = describeIntercept2, selectorFor = selectorFor2, isCheckable = isCheckable2, truthyValue = truthyValue2, nativeSetValue = nativeSetValue2, focusSafely = focusSafely2, fillElement = fillElement2, keyInfo = keyInfo2, isPrintableKey = isPrintableKey2, keyEvt = keyEvt2, contentEditableHost = contentEditableHost2, insertIntoContentEditable = insertIntoContentEditable2;
      const win = doc.defaultView;
      if (args.action === "click") {
        const el = resolve2(args.uid);
        if (!el) {
          return notFound2(args.uid);
        }
        scrollTo2(el);
        let intercepted;
        const efp = doc.elementFromPoint;
        if (typeof efp === "function") {
          try {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              const cx = r.left + r.width / 2;
              const cy = r.top + r.height / 2;
              const topmost = efp.call(doc, cx, cy);
              if (topmost && classifyHit2(el, topmost) === "unrelated") {
                intercepted = describeIntercept2(topmost);
              }
            }
          } catch (e) {
          }
        }
        if (intercepted && args.failIfIntercepted) {
          return {
            ok: false,
            intercepted,
            error: "click intercepted by " + selectorFor2(intercepted)
          };
        }
        dispatchClickSequence2(el, args.doubleClick);
        return intercepted ? { ok: true, intercepted } : { ok: true };
      }
      if (args.action === "hover") {
        const el = resolve2(args.uid);
        if (!el) {
          return notFound2(args.uid);
        }
        scrollTo2(el);
        const hc = elementCenter2(el);
        el.dispatchEvent(mouseEvt2("pointerover", { x: hc.x, y: hc.y }));
        el.dispatchEvent(mouseEvt2("pointerenter", { x: hc.x, y: hc.y }));
        el.dispatchEvent(mouseEvt2("pointermove", { x: hc.x, y: hc.y }));
        el.dispatchEvent(mouseEvt2("mouseover", { x: hc.x, y: hc.y }));
        el.dispatchEvent(mouseEvt2("mouseenter", { x: hc.x, y: hc.y }));
        el.dispatchEvent(mouseEvt2("mousemove", { x: hc.x, y: hc.y }));
        return { ok: true };
      }
      if (args.action === "fill") {
        const el = resolve2(args.uid);
        if (!el) {
          return notFound2(args.uid);
        }
        return fillElement2(el, args.value);
      }
      if (args.action === "fill-form") {
        for (let i = 0; i < args.fields.length; i++) {
          const field = args.fields[i];
          const el = resolve2(field.uid);
          if (!el) {
            return notFound2(field.uid);
          }
          const r = fillElement2(el, field.value);
          if (!r.ok) {
            return r;
          }
        }
        return { ok: true };
      }
      if (args.action === "type") {
        const active = doc.activeElement;
        const tag = active ? active.tagName : "";
        const isField = tag === "INPUT" || tag === "TEXTAREA";
        const isCE = !!active && contentEditableHost2(active);
        if (!active || !isField && !isCE) {
          return {
            ok: false,
            error: "No focused element to type into \u2014 click or fill an input first."
          };
        }
        const el = active;
        const text = args.text;
        if (isField) {
          const current = el.value || "";
          nativeSetValue2(el, current + text);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          insertIntoContentEditable2(el, text);
        }
        for (let i = 0; i < text.length; i++) {
          const ch = text.charAt(i);
          el.dispatchEvent(keyEvt2("keydown", ch));
          if (isPrintableKey2(ch)) {
            el.dispatchEvent(keyEvt2("keypress", ch));
          }
          el.dispatchEvent(keyEvt2("keyup", ch));
        }
        if (args.submit) {
          el.dispatchEvent(keyEvt2("keydown", "Enter"));
          el.dispatchEvent(keyEvt2("keyup", "Enter"));
          const form = el.form;
          if (form) {
            try {
              const rs = form.requestSubmit;
              if (typeof rs === "function") {
                rs.call(form);
              } else {
                form.submit();
              }
            } catch (e) {
            }
          }
        }
        return { ok: true };
      }
      if (args.action === "press-key") {
        const target = doc.activeElement || doc.body;
        const mods = {};
        const list = args.modifiers || [];
        for (let i = 0; i < list.length; i++) {
          const m = (list[i] || "").toLowerCase();
          if (m === "ctrl" || m === "control") {
            mods.ctrl = true;
          } else if (m === "shift") {
            mods.shift = true;
          } else if (m === "alt") {
            mods.alt = true;
          } else if (m === "meta" || m === "cmd" || m === "command") {
            mods.meta = true;
          }
        }
        target.dispatchEvent(keyEvt2("keydown", args.key, mods));
        if (isPrintableKey2(args.key) && !mods.ctrl && !mods.alt && !mods.meta) {
          target.dispatchEvent(keyEvt2("keypress", args.key, mods));
        }
        target.dispatchEvent(keyEvt2("keyup", args.key, mods));
        return { ok: true };
      }
      if (args.action === "drag") {
        let dragEvt2 = function(type, target) {
          let ev;
          const DragEventCtor = win ? win.DragEvent : void 0;
          if (DragEventCtor) {
            ev = new DragEventCtor(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: dt
            });
          } else {
            ev = new MouseEvent(type, { bubbles: true, cancelable: true });
            try {
              Object.defineProperty(ev, "dataTransfer", { value: dt });
            } catch (e) {
            }
          }
          target.dispatchEvent(ev);
        }, pointerEvt2 = function(type, target) {
          let ev;
          const PointerEventCtor = win ? win.PointerEvent : void 0;
          if (PointerEventCtor) {
            ev = new PointerEventCtor(type, { bubbles: true, cancelable: true });
          } else {
            ev = new MouseEvent(type, { bubbles: true, cancelable: true });
          }
          target.dispatchEvent(ev);
        };
        var dragEvt = dragEvt2, pointerEvt = pointerEvt2;
        const from = resolve2(args.fromUid);
        if (!from) {
          return notFound2(args.fromUid);
        }
        const to = resolve2(args.toUid);
        if (!to) {
          return notFound2(args.toUid);
        }
        scrollTo2(from);
        let dt;
        try {
          dt = win ? new win.DataTransfer() : null;
        } catch (e) {
          dt = null;
        }
        pointerEvt2("pointerdown", from);
        from.dispatchEvent(mouseEvt2("mousedown"));
        dragEvt2("dragstart", from);
        dragEvt2("dragenter", to);
        pointerEvt2("pointermove", to);
        to.dispatchEvent(mouseEvt2("mousemove"));
        dragEvt2("dragover", to);
        dragEvt2("drop", to);
        dragEvt2("dragend", from);
        pointerEvt2("pointerup", to);
        to.dispatchEvent(mouseEvt2("mouseup"));
        return { ok: true };
      }
      return { ok: false, error: "Unknown action" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // chrome-extension/injected/snapshot-script.ts
  function buildSnapshot(doc, options) {
    const verbose = !!options.verbose;
    const maxLength = options.maxLength;
    const includePointer = options.includePointer !== false;
    const maxInteractive = typeof options.maxInteractive === "number" ? options.maxInteractive : 500;
    const UID_ATTR = "data-bcmcp-uid";
    const SIG_ATTR = "data-bcmcp-sig";
    const NAME_MAX = 120;
    function bcmcpSig(el) {
      var role = el.getAttribute && (el.getAttribute("role") || "");
      var name = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("data-testid") || "") || "";
      var t = (el.tagName || "") + "|" + role + "|" + (el.id || "") + "|" + name;
      var h = 0;
      for (var i = 0; i < t.length; i++) {
        h = (h << 5) - h + t.charCodeAt(i) | 0;
      }
      return (h >>> 0).toString(36);
    }
    const layoutActive = (function() {
      try {
        const de = doc.documentElement;
        if (de && typeof de.getBoundingClientRect === "function") {
          const r = de.getBoundingClientRect();
          return !!(r && r.height > 0);
        }
      } catch (e) {
      }
      return false;
    })();
    function collapseWhitespace(s) {
      return s.replace(/\s+/g, " ").trim();
    }
    function clip(s) {
      const collapsed = collapseWhitespace(s);
      if (collapsed.length > NAME_MAX) {
        return collapsed.slice(0, NAME_MAX);
      }
      return collapsed;
    }
    function getInlineStyle(el) {
      return (el.getAttribute("style") || "").toLowerCase();
    }
    function isHidden(el) {
      if (el.hasAttribute("hidden")) {
        return true;
      }
      if (el.getAttribute("aria-hidden") === "true") {
        return true;
      }
      const tag = el.tagName.toLowerCase();
      if (tag === "input" && el.getAttribute("type") === "hidden") {
        return true;
      }
      const style = getInlineStyle(el);
      if (/display\s*:\s*none/.test(style)) {
        return true;
      }
      if (/visibility\s*:\s*hidden/.test(style)) {
        return true;
      }
      const dv = doc.defaultView;
      if (dv && typeof dv.getComputedStyle === "function") {
        let cs = null;
        try {
          cs = dv.getComputedStyle(el);
        } catch (e) {
          cs = null;
        }
        if (cs) {
          if (cs.display === "none") {
            return true;
          }
          if (cs.visibility === "hidden" || cs.visibility === "collapse") {
            return true;
          }
        }
        if (layoutActive) {
          try {
            const r = el.getBoundingClientRect();
            if (r && r.width === 0 && r.height === 0) {
              return true;
            }
          } catch (e) {
          }
        }
        let p = el.parentElement;
        while (p) {
          let pcs = null;
          try {
            pcs = dv.getComputedStyle(p);
          } catch (e) {
            pcs = null;
          }
          if (pcs && pcs.display === "none") {
            return true;
          }
          p = p.parentElement;
        }
      }
      return false;
    }
    function getRole(el) {
      const explicit = el.getAttribute("role");
      if (explicit) {
        return explicit.trim();
      }
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "a" && el.hasAttribute("href")) {
        return "link";
      }
      if (tag === "summary") {
        return "button";
      }
      if (tag === "button") {
        return "button";
      }
      if (tag === "input") {
        if (type === "button" || type === "submit" || type === "reset") {
          return "button";
        }
        if (type === "checkbox") {
          return "checkbox";
        }
        if (type === "radio") {
          return "radio";
        }
        if (type === "search") {
          return "searchbox";
        }
        return "textbox";
      }
      if (tag === "textarea") {
        return "textbox";
      }
      if (tag === "select") {
        return "combobox";
      }
      if (el.hasAttribute("contenteditable")) {
        const ce = (el.getAttribute("contenteditable") || "").toLowerCase();
        if (ce !== "false") {
          return "textbox";
        }
      }
      if (/^h[1-6]$/.test(tag)) {
        return "heading";
      }
      return "clickable";
    }
    function labelFromFor(el) {
      const id = el.getAttribute("id");
      if (!id) {
        return "";
      }
      let selectorId = id;
      try {
        const anyWin = doc.defaultView;
        if (anyWin && anyWin.CSS && typeof anyWin.CSS.escape === "function") {
          selectorId = anyWin.CSS.escape(id);
        }
      } catch (e) {
        selectorId = id;
      }
      let labelEl = null;
      try {
        labelEl = doc.querySelector('label[for="' + selectorId + '"]');
      } catch (e) {
        labelEl = null;
      }
      if (labelEl && labelEl.textContent) {
        return labelEl.textContent;
      }
      return "";
    }
    function labelFromAncestor(el) {
      let node = el.parentElement;
      while (node) {
        if (node.tagName.toLowerCase() === "label") {
          const clone = node.cloneNode(true);
          const controls = clone.querySelectorAll(
            "input, select, textarea, button"
          );
          for (let i = 0; i < controls.length; i++) {
            controls[i].remove();
          }
          return clone.textContent || "";
        }
        node = node.parentElement;
      }
      return "";
    }
    function nameFromLabelledBy(el) {
      const ref = el.getAttribute("aria-labelledby");
      if (!ref) {
        return "";
      }
      const ids = ref.split(/\s+/);
      const parts = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (!id) {
          continue;
        }
        let target = null;
        try {
          target = doc.getElementById(id);
        } catch (e) {
          target = null;
        }
        if (target && target.textContent) {
          parts.push(target.textContent);
        }
      }
      return parts.join(" ");
    }
    function isNameFromContentsRole(role) {
      switch (role) {
        case "option":
        case "tab":
        case "menuitem":
        case "menuitemcheckbox":
        case "menuitemradio":
        case "treeitem":
        case "radio":
        case "checkbox":
        case "switch":
        case "gridcell":
        case "cell":
        case "columnheader":
        case "rowheader":
        case "listitem":
          return true;
        default:
          return false;
      }
    }
    function getAccessibleName(el, role) {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && collapseWhitespace(ariaLabel)) {
        return clip(ariaLabel);
      }
      const labelledBy = nameFromLabelledBy(el);
      if (collapseWhitespace(labelledBy)) {
        return clip(labelledBy);
      }
      const forLabel = labelFromFor(el);
      if (collapseWhitespace(forLabel)) {
        return clip(forLabel);
      }
      const ancestorLabel = labelFromAncestor(el);
      if (collapseWhitespace(ancestorLabel)) {
        return clip(ancestorLabel);
      }
      const tag = el.tagName.toLowerCase();
      if (tag === "img") {
        const alt = el.getAttribute("alt");
        if (alt && collapseWhitespace(alt)) {
          return clip(alt);
        }
      }
      const title = el.getAttribute("title");
      if (title && collapseWhitespace(title)) {
        return clip(title);
      }
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && collapseWhitespace(placeholder)) {
        return clip(placeholder);
      }
      if (role === "combobox" || role === "textbox") {
        const childName = childValueText(el);
        if (collapseWhitespace(childName)) {
          return clip(childName);
        }
      }
      const hasExplicitRole = !!el.getAttribute("role");
      if (role === "link" || role === "button" || role === "heading" || isNameFromContentsRole(role) || (role === "combobox" || role === "textbox") && hasExplicitRole) {
        const text = el.textContent || "";
        if (collapseWhitespace(text)) {
          return clip(text);
        }
      }
      return "";
    }
    function getStateFlags(el, role) {
      const flags = [];
      const disabledAttr = el.disabled === true || el.hasAttribute("disabled");
      if (disabledAttr || el.getAttribute("aria-disabled") === "true") {
        flags.push("disabled");
      }
      if (role === "checkbox" || role === "radio") {
        const checked = el.checked === true || el.hasAttribute("checked") || el.getAttribute("aria-checked") === "true";
        if (checked) {
          flags.push("checked");
        }
      }
      const required = el.required === true || el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
      if (required) {
        flags.push("required");
      }
      const expanded = el.getAttribute("aria-expanded");
      if (expanded === "true") {
        flags.push("expanded");
      } else if (expanded === "false") {
        flags.push("collapsed");
      }
      if (el.getAttribute("aria-selected") === "true") {
        flags.push("selected");
      }
      return flags;
    }
    const VALUE_MAX = 80;
    const SECTION_MAX = 60;
    function formatSlot(s, max) {
      const cleaned = collapseWhitespace(s).replace(/\|/g, "/");
      if (cleaned.length > max) {
        return cleaned.slice(0, max);
      }
      return cleaned;
    }
    function getCurrentValue(el, role) {
      const tag = el.tagName.toLowerCase();
      if (tag === "textarea") {
        return el.value || "";
      }
      if (tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox" || type === "radio" || type === "button" || type === "submit" || type === "reset" || type === "hidden" || type === "file" || type === "image" || type === "password") {
          return "";
        }
        return el.value || "";
      }
      if (tag === "select") {
        const sel = el;
        const opts = sel.selectedOptions;
        if (opts && opts.length > 0 && opts[0].textContent) {
          return opts[0].textContent;
        }
        const idx = sel.selectedIndex;
        if (idx >= 0 && sel.options && sel.options[idx] && sel.options[idx].textContent) {
          return sel.options[idx].textContent;
        }
        return "";
      }
      if (role === "combobox") {
        const valueText = el.getAttribute("aria-valuetext");
        if (valueText && collapseWhitespace(valueText)) {
          return valueText;
        }
        const valueNow = el.getAttribute("aria-valuenow");
        if (valueNow && collapseWhitespace(valueNow)) {
          return valueNow;
        }
        const single = el.querySelector(
          '[class*="singleValue"], [class*="single-value"]'
        );
        if (single && collapseWhitespace(single.textContent || "")) {
          return single.textContent || "";
        }
        const ph = el.querySelector('[class*="placeholder"]');
        if (ph && collapseWhitespace(ph.textContent || "")) {
          return ph.textContent || "";
        }
        const phAttr = el.getAttribute("placeholder");
        if (phAttr && collapseWhitespace(phAttr)) {
          return phAttr;
        }
      }
      return "";
    }
    function childValueText(el) {
      const single = el.querySelector(
        '[class*="singleValue"], [class*="single-value"]'
      );
      if (single && collapseWhitespace(single.textContent || "")) {
        return single.textContent || "";
      }
      const ph = el.querySelector('[class*="placeholder"]');
      if (ph && collapseWhitespace(ph.textContent || "")) {
        return ph.textContent || "";
      }
      return "";
    }
    function makeRow(el, role, name, value, section, flags, uid) {
      const nameSlot = formatSlot(name, NAME_MAX);
      const valueClean = formatSlot(value, VALUE_MAX);
      const sectionSlot = formatSlot(section, SECTION_MAX);
      const valueSlot = valueClean && valueClean !== nameSlot ? '"' + valueClean + '"' : "";
      let line = role + ' "' + nameSlot + '" | ' + valueSlot + " | " + sectionSlot + " [uid=" + uid + "]";
      if (flags.length > 0) {
        line += " (" + flags.join(", ") + ")";
      }
      return line;
    }
    function isHeading(el) {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        return true;
      }
      return el.getAttribute("role") === "heading";
    }
    function getSection(el) {
      const fs = el.closest("fieldset");
      if (fs) {
        const legend = fs.querySelector("legend");
        if (legend && collapseWhitespace(legend.textContent || "")) {
          return legend.textContent || "";
        }
      }
      const container = el.closest(
        'section,[role="group"],[class*="card"],[aria-labelledby]'
      );
      if (container) {
        const labelled = nameFromLabelledBy(container);
        if (collapseWhitespace(labelled)) {
          return labelled;
        }
        const heading = container.querySelector(
          'h1,h2,h3,h4,h5,h6,[role="heading"]'
        );
        if (heading && collapseWhitespace(heading.textContent || "")) {
          return heading.textContent || "";
        }
      }
      let node = el.parentElement;
      while (node) {
        let sib = node.previousElementSibling;
        while (sib) {
          if (isHeading(sib) && collapseWhitespace(sib.textContent || "")) {
            return sib.textContent || "";
          }
          sib = sib.previousElementSibling;
        }
        node = node.parentElement;
      }
      return "";
    }
    const stale = doc.querySelectorAll("[" + UID_ATTR + "]");
    for (let i = 0; i < stale.length; i++) {
      stale[i].removeAttribute(UID_ATTR);
      stale[i].removeAttribute(SIG_ATTR);
    }
    const baseSelectors = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "textarea",
      "select",
      "[role]",
      "[tabindex]",
      "[onclick]",
      "summary",
      '[contenteditable]:not([contenteditable="false"])'
    ];
    const verboseSelectors = ["h1", "h2", "h3", "h4", "h5", "h6", "[aria-label]"];
    const baseSelectorString = (verbose ? baseSelectors.concat(verboseSelectors) : baseSelectors).join(",");
    const selectorMode = typeof options.selector === "string" && options.selector.length > 0;
    const textMode = typeof options.textContains === "string" && options.textContains.length > 0;
    const textNeedle = textMode ? options.textContains.toLowerCase() : "";
    function ownTextIncludesNeedle(el) {
      return (el.textContent || "").toLowerCase().indexOf(textNeedle) !== -1;
    }
    function isLeafTextMatch(el) {
      const kids = el.querySelectorAll("*");
      for (let k = 0; k < kids.length; k++) {
        if (ownTextIncludesNeedle(kids[k])) {
          return false;
        }
      }
      return true;
    }
    let root = doc;
    if (typeof options.rootSelector === "string" && options.rootSelector.length > 0) {
      let scoped = null;
      try {
        scoped = doc.querySelector(options.rootSelector);
      } catch (e) {
        return {
          tree: "",
          isTruncated: false,
          total: 0,
          hasMore: false,
          error: "Invalid rootSelector: " + options.rootSelector
        };
      }
      if (!scoped) {
        return {
          tree: "",
          isTruncated: false,
          total: 0,
          hasMore: false,
          error: "rootSelector matched no element: " + options.rootSelector
        };
      }
      root = scoped;
    }
    let candidates;
    if (selectorMode) {
      try {
        candidates = Array.prototype.slice.call(
          root.querySelectorAll(options.selector)
        );
      } catch (e) {
        return {
          tree: "",
          isTruncated: false,
          total: 0,
          hasMore: false,
          error: "Invalid CSS selector: " + options.selector
        };
      }
    } else if (textMode) {
      candidates = Array.prototype.slice.call(root.querySelectorAll("*"));
    } else {
      candidates = Array.prototype.slice.call(
        root.querySelectorAll(baseSelectorString)
      );
    }
    if (textMode) {
      candidates = candidates.filter(
        (el) => ownTextIncludesNeedle(el) && isLeafTextMatch(el)
      );
    }
    const lines = [];
    let uidCounter = 0;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (isHidden(el)) {
        continue;
      }
      const role = getRole(el);
      let name = getAccessibleName(el, role);
      if (textMode && !name) {
        name = clip(el.textContent || "");
      }
      const flags = getStateFlags(el, role);
      uidCounter += 1;
      const uid = "e" + uidCounter;
      el.setAttribute(UID_ATTR, uid);
      el.setAttribute(SIG_ATTR, bcmcpSig(el));
      lines.push(
        makeRow(el, role, name, getCurrentValue(el, role), getSection(el), flags, uid)
      );
    }
    const win = doc.defaultView;
    if (includePointer && !selectorMode && !textMode && win && typeof win.getComputedStyle === "function") {
      let ownDirectText2 = function(el) {
        const parts = [];
        const kids = el.childNodes;
        for (let k = 0; k < kids.length; k++) {
          const node = kids[k];
          if (node.nodeType === 3) {
            parts.push(node.textContent || "");
          }
        }
        return parts.join(" ");
      };
      var ownDirectText = ownDirectText2;
      const MAX_CLICKABLES = maxInteractive;
      let added = 0;
      const allEls = root.querySelectorAll("*");
      for (let i = 0; i < allEls.length && added < MAX_CLICKABLES; i++) {
        const el = allEls[i];
        if (el.hasAttribute(UID_ATTR)) {
          continue;
        }
        if (isHidden(el)) {
          continue;
        }
        let cursor = "";
        try {
          cursor = win.getComputedStyle(el).cursor || "";
        } catch (e) {
          cursor = "";
        }
        if (cursor !== "pointer") {
          continue;
        }
        if (el.querySelector("[" + UID_ATTR + "]")) {
          continue;
        }
        const ariaLabel = el.getAttribute("aria-label");
        let name = "";
        if (ariaLabel && collapseWhitespace(ariaLabel)) {
          name = clip(ariaLabel);
        } else {
          const direct = ownDirectText2(el);
          if (collapseWhitespace(direct)) {
            name = clip(direct);
          } else {
            const title = el.getAttribute("title");
            if (title && collapseWhitespace(title)) {
              name = clip(title);
            }
          }
        }
        if (!name) {
          continue;
        }
        const flags = getStateFlags(el, "clickable");
        uidCounter += 1;
        const uid = "e" + uidCounter;
        el.setAttribute(UID_ATTR, uid);
        el.setAttribute(SIG_ATTR, bcmcpSig(el));
        added += 1;
        lines.push(
          makeRow(
            el,
            "clickable",
            name,
            getCurrentValue(el, "clickable"),
            getSection(el),
            flags,
            uid
          )
        );
      }
    }
    const total = lines.length;
    const offset = typeof options.offset === "number" && options.offset > 0 ? Math.floor(options.offset) : 0;
    const hasLimit = typeof options.limit === "number" && options.limit >= 0;
    const limit = hasLimit ? Math.floor(options.limit) : void 0;
    let pagedLines = lines;
    if (offset > 0 || limit !== void 0) {
      pagedLines = lines.slice(
        offset,
        limit !== void 0 ? offset + limit : void 0
      );
    }
    const moreAfterPage = offset + pagedLines.length < total;
    const full = pagedLines.join("\n");
    if (full.length > maxLength) {
      const sliced = full.slice(0, maxLength);
      const lastNewline = sliced.lastIndexOf("\n");
      const tree = lastNewline >= 0 ? sliced.slice(0, lastNewline) : "";
      return { tree, isTruncated: true, total, hasMore: true };
    }
    return { tree: full, isTruncated: false, total, hasMore: moreAfterPage };
  }

  // chrome-extension/injected/point-action-script.ts
  function performPointAction(doc, args) {
    try {
      let elementAt2 = function(x, y) {
        const efp = doc.elementFromPoint;
        if (typeof efp !== "function") {
          return null;
        }
        return efp.call(doc, x, y);
      }, offPoint2 = function(x, y) {
        return {
          ok: false,
          error: "No element at point (" + x + ", " + y + ") \u2014 the coordinates may be outside the visible viewport or over a cross-origin frame."
        };
      }, isEditable2 = function(el) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
          return true;
        }
        return el.isContentEditable === true;
      }, describeElement2 = function(el) {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? el.id : void 0;
        const classes = typeof el.className === "string" ? (el.getAttribute("class") || "").split(/\s+/).filter(Boolean) : [];
        const role = el.getAttribute("role") || void 0;
        const ariaLabel = el.getAttribute("aria-label");
        const rawName = ariaLabel || (el.textContent || "").replace(/\s+/g, " ").trim();
        const name = rawName ? rawName.slice(0, 80) : void 0;
        let rect = { x: 0, y: 0, w: 0, h: 0 };
        try {
          const r = el.getBoundingClientRect();
          rect = { x: r.left, y: r.top, w: r.width, h: r.height };
        } catch (e) {
        }
        return {
          tag,
          ...id ? { id } : {},
          classes,
          ...role ? { role } : {},
          ...name ? { name } : {},
          rect,
          editable: isEditable2(el)
        };
      }, mouseEvt2 = function(type, opts) {
        const o = opts || {};
        const x = typeof o.x === "number" ? o.x : 0;
        const y = typeof o.y === "number" ? o.y : 0;
        const isEnter = type === "mouseenter" || type === "mouseleave" || type === "pointerenter" || type === "pointerleave";
        const init = {
          bubbles: !isEnter,
          cancelable: true,
          composed: true,
          view: win,
          button: typeof o.button === "number" ? o.button : 0,
          buttons: typeof o.buttons === "number" ? o.buttons : 0,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y
        };
        const PE = win && win.PointerEvent;
        if (type.indexOf("pointer") === 0 && typeof PE === "function") {
          const pinit = init;
          pinit.pointerId = 1;
          pinit.pointerType = "mouse";
          pinit.isPrimary = true;
          return new PE(type, pinit);
        }
        return new MouseEvent(type, init);
      }, buttonsMask2 = function(b) {
        if (b === 2) return 2;
        if (b === 1) return 4;
        return 1;
      }, buttonCode2 = function(b) {
        if (b === "middle") return 1;
        if (b === "right") return 2;
        return 0;
      }, keyInfo2 = function(key) {
        const named = {
          Enter: ["Enter", 13],
          Tab: ["Tab", 9],
          Escape: ["Escape", 27],
          Esc: ["Escape", 27],
          Backspace: ["Backspace", 8],
          Delete: ["Delete", 46],
          ArrowUp: ["ArrowUp", 38],
          ArrowDown: ["ArrowDown", 40],
          ArrowLeft: ["ArrowLeft", 37],
          ArrowRight: ["ArrowRight", 39],
          Home: ["Home", 36],
          End: ["End", 35],
          PageUp: ["PageUp", 33],
          PageDown: ["PageDown", 34],
          " ": ["Space", 32],
          Spacebar: ["Space", 32]
        };
        if (named[key]) {
          return { code: named[key][0], keyCode: named[key][1] };
        }
        if (key && key.length === 1) {
          const c = key;
          if (c >= "a" && c <= "z") {
            return { code: "Key" + c.toUpperCase(), keyCode: c.toUpperCase().charCodeAt(0) };
          }
          if (c >= "A" && c <= "Z") {
            return { code: "Key" + c, keyCode: c.charCodeAt(0) };
          }
          if (c >= "0" && c <= "9") {
            return { code: "Digit" + c, keyCode: c.charCodeAt(0) };
          }
          return { code: "", keyCode: c.charCodeAt(0) };
        }
        return { code: "", keyCode: 0 };
      }, isPrintableKey2 = function(key) {
        return !!key && key.length === 1;
      }, keyEvt2 = function(type, key) {
        const info = keyInfo2(key);
        const ev = new KeyboardEvent(type, {
          key,
          code: info.code,
          bubbles: true,
          cancelable: true,
          composed: true,
          view: win
        });
        try {
          Object.defineProperty(ev, "keyCode", {
            get: function() {
              return info.keyCode;
            }
          });
          Object.defineProperty(ev, "which", {
            get: function() {
              return info.keyCode;
            }
          });
        } catch (e) {
        }
        return ev;
      }, insertIntoContentEditable2 = function(el, text) {
        const IE = win && win.InputEvent;
        let beforeEv;
        if (typeof IE === "function") {
          beforeEv = new IE("beforeinput", {
            inputType: "insertText",
            data: text,
            bubbles: true,
            cancelable: true,
            composed: true
          });
        } else {
          beforeEv = new Event("beforeinput", { bubbles: true, cancelable: true });
          try {
            Object.defineProperty(beforeEv, "inputType", { value: "insertText" });
            Object.defineProperty(beforeEv, "data", { value: text });
          } catch (e) {
          }
        }
        const notPrevented = el.dispatchEvent(beforeEv);
        if (notPrevented) {
          let inserted = false;
          const doExec = doc.execCommand;
          if (typeof doExec === "function") {
            try {
              inserted = doExec.call(doc, "insertText", false, text);
            } catch (e) {
              inserted = false;
            }
          }
          if (!inserted) {
            el.textContent = (el.textContent || "") + text;
          }
          let inputEv;
          if (typeof IE === "function") {
            inputEv = new IE("input", {
              inputType: "insertText",
              data: text,
              bubbles: true,
              composed: true
            });
          } else {
            inputEv = new Event("input", { bubbles: true });
            try {
              Object.defineProperty(inputEv, "inputType", { value: "insertText" });
              Object.defineProperty(inputEv, "data", { value: text });
            } catch (e) {
            }
          }
          el.dispatchEvent(inputEv);
        }
      }, nativeSetValue2 = function(el, value) {
        const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        const setter = descriptor && descriptor.set;
        if (setter) {
          setter.call(el, value);
        } else {
          el.value = value;
        }
      }, contentEditableHost2 = function(el) {
        if (el.isContentEditable === true) {
          return true;
        }
        const ce = el.getAttribute("contenteditable");
        return ce === "" || ce === "true" || ce === "plaintext-only";
      };
      var elementAt = elementAt2, offPoint = offPoint2, isEditable = isEditable2, describeElement = describeElement2, mouseEvt = mouseEvt2, buttonsMask = buttonsMask2, buttonCode = buttonCode2, keyInfo = keyInfo2, isPrintableKey = isPrintableKey2, keyEvt = keyEvt2, insertIntoContentEditable = insertIntoContentEditable2, nativeSetValue = nativeSetValue2, contentEditableHost = contentEditableHost2;
      const win = doc.defaultView;
      if (args.action === "click-at") {
        const el = elementAt2(args.x, args.y);
        if (!el) {
          return offPoint2(args.x, args.y);
        }
        const b = buttonCode2(args.button);
        const x = args.x;
        const y = args.y;
        const bm = buttonsMask2(b);
        el.dispatchEvent(mouseEvt2("pointerover", { x, y, button: b }));
        el.dispatchEvent(mouseEvt2("pointerenter", { x, y, button: b }));
        el.dispatchEvent(mouseEvt2("pointermove", { x, y, button: b }));
        el.dispatchEvent(mouseEvt2("pointerdown", { x, y, button: b, buttons: bm }));
        el.dispatchEvent(mouseEvt2("mousedown", { x, y, button: b, buttons: bm }));
        try {
          el.focus?.();
        } catch (e) {
        }
        el.dispatchEvent(mouseEvt2("pointerup", { x, y, button: b, buttons: 0 }));
        el.dispatchEvent(mouseEvt2("mouseup", { x, y, button: b, buttons: 0 }));
        if (b === 2) {
          el.dispatchEvent(mouseEvt2("contextmenu", { x, y, button: b }));
        } else if (b === 1) {
          el.dispatchEvent(mouseEvt2("auxclick", { x, y, button: b }));
        } else {
          try {
            el.click?.();
          } catch (e) {
          }
        }
        if (args.doubleClick) {
          el.dispatchEvent(mouseEvt2("dblclick", { x, y, button: b }));
        }
        return { ok: true, element: describeElement2(el) };
      }
      if (args.action === "type-at") {
        const el = elementAt2(args.x, args.y);
        if (!el) {
          return offPoint2(args.x, args.y);
        }
        const x = args.x;
        const y = args.y;
        el.dispatchEvent(mouseEvt2("pointerdown", { x, y, buttons: 1 }));
        el.dispatchEvent(mouseEvt2("mousedown", { x, y, buttons: 1 }));
        try {
          el.focus?.();
        } catch (e) {
        }
        el.dispatchEvent(mouseEvt2("pointerup", { x, y, buttons: 0 }));
        el.dispatchEvent(mouseEvt2("mouseup", { x, y, buttons: 0 }));
        try {
          el.click?.();
        } catch (e) {
        }
        const text = args.text;
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") {
          const current = el.value || "";
          nativeSetValue2(el, current + text);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else if (contentEditableHost2(el)) {
          insertIntoContentEditable2(el, text);
        } else {
          return {
            ok: false,
            error: "Element at point is not typable (not an input, textarea, or contenteditable).",
            element: describeElement2(el)
          };
        }
        for (let i = 0; i < text.length; i++) {
          const ch = text.charAt(i);
          el.dispatchEvent(keyEvt2("keydown", ch));
          if (isPrintableKey2(ch)) {
            el.dispatchEvent(keyEvt2("keypress", ch));
          }
          el.dispatchEvent(keyEvt2("keyup", ch));
        }
        if (args.submit) {
          el.dispatchEvent(keyEvt2("keydown", "Enter"));
          el.dispatchEvent(keyEvt2("keyup", "Enter"));
          const form = el.form;
          if (form) {
            try {
              const rs = form.requestSubmit;
              if (typeof rs === "function") {
                rs.call(form);
              } else {
                form.submit();
              }
            } catch (e) {
            }
          }
        }
        return { ok: true, element: describeElement2(el) };
      }
      if (args.action === "hover-at") {
        const el = elementAt2(args.x, args.y);
        if (!el) {
          return offPoint2(args.x, args.y);
        }
        const x = args.x;
        const y = args.y;
        el.dispatchEvent(mouseEvt2("pointerover", { x, y }));
        el.dispatchEvent(mouseEvt2("pointerenter", { x, y }));
        el.dispatchEvent(mouseEvt2("pointermove", { x, y }));
        el.dispatchEvent(mouseEvt2("mouseover", { x, y }));
        el.dispatchEvent(mouseEvt2("mouseenter", { x, y }));
        el.dispatchEvent(mouseEvt2("mousemove", { x, y }));
        return { ok: true, element: describeElement2(el) };
      }
      if (args.action === "scroll-at") {
        let isScrollable2 = function(node) {
          if (!win || typeof win.getComputedStyle !== "function") {
            return false;
          }
          let oy = "";
          let ox = "";
          try {
            const cs = win.getComputedStyle(node);
            oy = cs.overflowY || "";
            ox = cs.overflowX || "";
          } catch (e) {
            return false;
          }
          const canY = (oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight;
          const canX = (ox === "auto" || ox === "scroll") && node.scrollWidth > node.clientWidth;
          return canY || canX;
        };
        var isScrollable = isScrollable2;
        const el = elementAt2(args.x, args.y);
        if (!el) {
          return offPoint2(args.x, args.y);
        }
        let container = el;
        while (container && !isScrollable2(container)) {
          container = container.parentElement;
        }
        const dx = typeof args.dx === "number" ? args.dx : 0;
        const viewportH = win ? win.innerHeight || 0 : 0;
        if (container) {
          const dy = typeof args.dy === "number" ? args.dy : container.clientHeight || viewportH || 600;
          const sb = container.scrollBy;
          if (typeof sb === "function") {
            sb.call(container, dx, dy);
          } else {
            container.scrollTop += dy;
            container.scrollLeft += dx;
          }
          return { ok: true, element: describeElement2(container) };
        }
        const dyWin = typeof args.dy === "number" ? args.dy : viewportH || 600;
        if (win && typeof win.scrollBy === "function") {
          win.scrollBy(dx, dyWin);
        }
        return { ok: true, element: describeElement2(el) };
      }
      if (args.action === "describe-at") {
        const el = elementAt2(args.x, args.y);
        if (!el) {
          return offPoint2(args.x, args.y);
        }
        return { ok: true, element: describeElement2(el) };
      }
      return { ok: false, error: "Unknown point action" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // chrome-extension/injected/select-option-script.ts
  async function selectOption(doc, args) {
    const UID_ATTR = "data-bcmcp-uid";
    const wantExact = args.exact === true;
    const rawWant = args.option == null ? "" : String(args.option);
    const want = rawWant.replace(/\s+/g, " ").trim().toLowerCase();
    function norm(s) {
      return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
    }
    function textMatches(candidate) {
      const c = norm(candidate).toLowerCase();
      if (c.length === 0) {
        return false;
      }
      return wantExact ? c === want : c.indexOf(want) !== -1;
    }
    function isLeafTextMatch(el) {
      if (!textMatches(el.textContent || "")) {
        return false;
      }
      const kids = el.querySelectorAll(
        '[role="option"], [role="listbox"] li, li[role="option"], .select__option'
      );
      for (let k = 0; k < kids.length; k++) {
        if (textMatches(kids[k].textContent || "")) {
          return false;
        }
      }
      return true;
    }
    function sleep(ms) {
      return new Promise(function(r) {
        setTimeout(r, ms);
      });
    }
    function bcmcpSig(el) {
      var role = el.getAttribute && (el.getAttribute("role") || "");
      var name = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("data-testid") || "") || "";
      var t = (el.tagName || "") + "|" + role + "|" + (el.id || "") + "|" + name;
      var h = 0;
      for (var i = 0; i < t.length; i++) {
        h = (h << 5) - h + t.charCodeAt(i) | 0;
      }
      return (h >>> 0).toString(36);
    }
    try {
      let mouseEvt2 = function(type) {
        return new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: win
        });
      }, activate2 = function(node) {
        node.dispatchEvent(mouseEvt2("pointerdown"));
        node.dispatchEvent(mouseEvt2("mousedown"));
        node.dispatchEvent(mouseEvt2("mouseup"));
        try {
          node.focus?.();
        } catch (e) {
        }
        try {
          node.click?.();
        } catch (e) {
        }
      }, findSearchInput2 = function(control) {
        if (control.tagName === "INPUT" && (control.getAttribute("type") || "text").toLowerCase() !== "hidden") {
          return control;
        }
        const local = control.querySelector(
          'input:not([type="hidden"])'
        );
        if (local) {
          return local;
        }
        const ref = (control.getAttribute("aria-controls") || "") + " " + (control.getAttribute("aria-owns") || "");
        const ids = ref.split(/\s+/);
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          if (!id) {
            continue;
          }
          const container = doc.getElementById(id);
          if (container) {
            const scoped = container.querySelector(
              'input:not([type="hidden"])'
            );
            if (scoped) {
              return scoped;
            }
          }
        }
        return null;
      }, findOption2 = function() {
        const nodes = doc.querySelectorAll(
          '[role="option"], [role="listbox"] li, li[role="option"], .select__option'
        );
        for (let i = 0; i < nodes.length; i++) {
          if (isLeafTextMatch(nodes[i])) {
            return nodes[i];
          }
        }
        return null;
      }, readDisplayed2 = function(control) {
        const single = control.querySelector(
          '[class*="singleValue"], [class*="single-value"]'
        );
        if (single && norm(single.textContent || "")) {
          return norm(single.textContent || "");
        }
        const vt = control.getAttribute("aria-valuetext");
        if (vt && norm(vt)) {
          return norm(vt);
        }
        return norm(control.textContent || "");
      };
      var mouseEvt = mouseEvt2, activate = activate2, findSearchInput = findSearchInput2, findOption = findOption2, readDisplayed = readDisplayed2;
      const win = doc.defaultView;
      const el = doc.querySelector("[" + UID_ATTR + '="' + args.uid + '"]');
      if (!el) {
        return {
          ok: false,
          error: "Element uid '" + args.uid + "' not found \u2014 take a fresh snapshot (uids are reassigned each snapshot)."
        };
      }
      const sig = el.getAttribute("data-bcmcp-sig");
      if (sig && bcmcpSig(el) !== sig) {
        return {
          ok: false,
          error: "Element uid '" + args.uid + "' not found \u2014 take a fresh snapshot (uids are reassigned each snapshot)."
        };
      }
      try {
        el.scrollIntoView?.({
          block: "center"
        });
      } catch (e) {
      }
      if (el.tagName === "SELECT") {
        const opts = el.options;
        let chosen = null;
        for (let i = 0; i < opts.length; i++) {
          const o = opts[i];
          if (textMatches(o.textContent || "") || textMatches(o.value || "")) {
            chosen = o;
            break;
          }
        }
        if (!chosen) {
          return {
            ok: false,
            error: 'No <option> matching "' + rawWant + '" in the native <select> uid ' + args.uid + "."
          };
        }
        el.value = chosen.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, selected: norm(chosen.textContent || chosen.value) };
      }
      activate2(el);
      const search = findSearchInput2(el);
      if (search) {
        try {
          search.focus?.();
        } catch (e) {
        }
        const proto = win.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        const setter = descriptor && descriptor.set;
        if (setter) {
          setter.call(search, rawWant);
        } else {
          search.value = rawWant;
        }
        search.dispatchEvent(new Event("input", { bubbles: true }));
        for (let i = 0; i < rawWant.length; i++) {
          const ch = rawWant.charAt(i);
          search.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
          search.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
        }
      }
      let optionEl = null;
      for (let iter = 0; iter < 15; iter++) {
        optionEl = findOption2();
        if (optionEl) {
          break;
        }
        await sleep(300);
      }
      if (!optionEl) {
        return {
          ok: false,
          error: 'No option matching "' + rawWant + '" appeared in the dropdown for uid ' + args.uid + " (opened the menu but the option never rendered \u2014 it may be a virtualized list, or the trigger is not a supported combobox)."
        };
      }
      try {
        optionEl.scrollIntoView?.({
          block: "center"
        });
      } catch (e) {
      }
      activate2(optionEl);
      await sleep(60);
      const shown = readDisplayed2(el);
      return { ok: true, selected: shown || norm(optionEl.textContent || "") };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // scratch-verify-entry.ts
  window.__fp = {
    performInputAction,
    buildSnapshot,
    performPointAction,
    selectOption
  };
})();
