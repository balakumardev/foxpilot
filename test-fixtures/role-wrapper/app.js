// Wires the role-wrapper click hazards (markup in index.html) to the #state
// oracle. Listeners only — no inline handlers — so the page stays strict-CSP
// clean. The hazards:
//   - li[role=menuitem] > button > p: the WRAPPER carries the role and the same
//     name as the button inside it, but only the button has a handler. Clicking
//     the wrapper's own element fires nothing.
//   - li[role=menuitem] with the handler on the li itself (nothing interactive
//     inside), which must keep working.
//   - a clickable card (handler on the card) holding two buttons whose handlers
//     stop propagation, as a card's secondary actions do in real apps — so every
//     click is attributable to exactly one handler.
//   - an antd-shaped label-wrapped checkbox + radios, a submit button and an
//     anchor whose visible text is a <span>, and a combobox/listbox/option
//     widget: the controls a click retargeting rule must not break.
//   - an icon-only overlay toggle; the overlay fully covers the menu.
// Oracle keys are camelCase on purpose, so no textContains needle can match
// the oracle's own text.
(function () {
  var state = {
    clicks: {
      draftMacos: 0,
      draftIos: 0,
      deleteDraft: 0,
      card: 0,
      cardEdit: 0,
      cardShare: 0,
      save: 0,
      anchor: 0,
      overlayToggle: 0,
    },
    dblclicks: { draftMacos: 0, draftIos: 0 },
    notify: false,
    notifyChanges: 0,
    plan: "basic",
    planChanges: 0,
    submits: 0,
    hash: location.hash,
    fruit: null,
    overlay: false,
    // Innermost node the last click actually hit (see the capture listener).
    lastClick: null,
  };
  var out = document.getElementById("state");
  function commit() {
    out.textContent = JSON.stringify(state, null, 2);
  }
  function byId(id) {
    return document.getElementById(id);
  }
  function describe(node) {
    if (!node || !node.tagName) {
      return String(node);
    }
    return node.tagName.toLowerCase() + (node.id ? "#" + node.id : "");
  }
  // Records where every click actually landed, so a failing test can say "the
  // click hit the <li>, not the button inside it".
  document.addEventListener(
    "click",
    function (e) {
      state.lastClick = describe(e.composedPath()[0]);
      commit();
    },
    true
  );

  function countClicks(id, key) {
    byId(id).addEventListener("click", function () {
      state.clicks[key] += 1;
      commit();
    });
  }
  function countDblclicks(id, key) {
    byId(id).addEventListener("dblclick", function () {
      state.dblclicks[key] += 1;
      commit();
    });
  }

  // Menu: handlers on the inner buttons, except "Delete draft" (on the li).
  countClicks("draft-macos", "draftMacos");
  countDblclicks("draft-macos", "draftMacos");
  countClicks("draft-ios", "draftIos");
  countDblclicks("draft-ios", "draftIos");
  countClicks("item-delete", "deleteDraft");

  var overlay = byId("menu-overlay");
  byId("overlay-toggle").addEventListener("click", function () {
    overlay.hidden = !overlay.hidden;
    state.overlay = !overlay.hidden;
    state.clicks.overlayToggle += 1;
    commit();
  });

  // Card + its secondary actions.
  countClicks("project-card", "card");
  [
    ["card-edit", "cardEdit"],
    ["card-share", "cardShare"],
  ].forEach(function (pair) {
    byId(pair[0]).addEventListener("click", function (e) {
      e.stopPropagation();
      state.clicks[pair[1]] += 1;
      commit();
    });
  });

  // Checkbox + radios: count real state changes, not clicks, so a double
  // activation (toggle on, straight back off) is visible as 2 changes.
  var notify = byId("notify");
  notify.addEventListener("change", function () {
    state.notify = notify.checked;
    state.notifyChanges += 1;
    commit();
  });
  Array.prototype.forEach.call(
    document.querySelectorAll('input[name="plan"]'),
    function (radio) {
      radio.addEventListener("change", function () {
        state.plan = radio.value;
        state.planChanges += 1;
        commit();
      });
    }
  );

  // Submit (kept on the page) and the anchor's hash navigation.
  countClicks("save-button", "save");
  byId("settings-form").addEventListener("submit", function (e) {
    e.preventDefault();
    state.submits += 1;
    commit();
  });
  countClicks("anchor-link", "anchor");
  window.addEventListener("hashchange", function () {
    state.hash = location.hash;
    commit();
  });

  // Combobox: a click toggles the listbox; an option click commits and closes.
  var combo = byId("fruit-combo");
  var listbox = byId("fruit-listbox");
  var fruitValue = byId("fruit-value");
  function setOpen(open) {
    listbox.hidden = !open;
    combo.setAttribute("aria-expanded", open ? "true" : "false");
  }
  combo.addEventListener("click", function () {
    setOpen(listbox.hidden);
  });
  Array.prototype.forEach.call(
    listbox.querySelectorAll('[role="option"]'),
    function (opt) {
      opt.addEventListener("click", function () {
        var text = (opt.textContent || "").trim();
        state.fruit = text;
        fruitValue.textContent = text;
        setOpen(false);
        commit();
      });
    }
  );

  commit();
})();
