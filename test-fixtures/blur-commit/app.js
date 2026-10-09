// A small stand-in for Google Play Console's "Invite new users" form
// (AngularDart / ACX), plus three neighbours that guard against FoxPilot
// leaving fields too eagerly. #state is the oracle the e2e spec reads.
//
// The invite form:
//  - material-input[blurupdate]: the inner <input>'s input event only updates
//    the component's own text. The form MODEL takes that text on the input's
//    blur event (a listener on the input itself, as Angular's (blur) binding
//    adds). Nothing else commits it: not input, change or keys.
//  - Change detection runs after the event turn (a microtask, like a zone), so
//    aria-invalid, the helper text and the Invite button update only then.
//  - "Invite user" is enabled only when the committed email is valid AND at
//    least one app permission was applied (Play Console's second gate).
//  - "Add app" opens a dialog and moves focus into it from its click handler.
(function () {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const email = $("email");
  const label = email.closest("label");
  const helper = $("email-helper");
  const addApp = $("add-app");
  const dialog = $("app-dialog");
  const apply = $("apply");
  const invite = $("invite");
  const name = $("display-name");
  const city = $("city");
  const cityList = $("city-list");
  const search = $("search");
  const stateEl = $("state");
  const CITIES = ["New York", "Newark", "Boston"];

  const state = {
    ready: false,
    unfocused: !!window.__unfocused,
    email: { text: "", committed: null, touched: false, focused: false, commits: 0 },
    dialogOpen: false,
    dialogFocusEvents: 0,
    permissions: [],
    inviteEnabled: false,
    invited: null,
    displayName: { committed: null, commits: 0 },
    city: { query: "", value: null, open: false },
    searched: null,
    // Focus events seen on the fields, "type:id:t" (trusted) or ":u".
    events: [],
  };

  function emailValid() {
    return !!state.email.committed && EMAIL_RE.test(state.email.committed);
  }

  function detectChanges() {
    const invalid = state.email.touched && !emailValid();
    email.setAttribute("aria-invalid", String(invalid));
    label.classList.toggle("mdc-text-field--invalid", invalid);
    helper.textContent = invalid
      ? state.email.committed
        ? "Enter a valid email address"
        : "Enter an email address"
      : "";
    state.inviteEnabled = emailValid() && state.permissions.length > 0;
    invite.disabled = !state.inviteEnabled;
    dialog.hidden = !state.dialogOpen;
    city.setAttribute("aria-expanded", String(state.city.open));
    stateEl.textContent = JSON.stringify(state, null, 2);
  }
  let scheduled = false;
  function scheduleChangeDetection() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    Promise.resolve().then(function () {
      scheduled = false;
      detectChanges();
    });
  }

  // material-input[blurupdate] bindings, all on the inner <input>.
  email.addEventListener("input", function () {
    state.email.text = email.value;
    scheduleChangeDetection();
  });
  email.addEventListener("focus", function () {
    state.email.focused = true;
    scheduleChangeDetection();
  });
  email.addEventListener("blur", function () {
    state.email.focused = false;
    state.email.touched = true;
    state.email.committed = state.email.text;
    state.email.commits++;
    scheduleChangeDetection();
  });
  // ACX's (change) binding stops the event; with blurupdate it commits nothing.
  email.addEventListener("change", function (e) {
    e.stopPropagation();
  });

  addApp.addEventListener("click", function () {
    state.dialogOpen = true;
    dialog.hidden = false;
    $("perm-testing").focus();
    scheduleChangeDetection();
  });
  $("perm-testing").addEventListener("focus", function () {
    state.dialogFocusEvents++;
    scheduleChangeDetection();
  });
  apply.addEventListener("click", function () {
    state.permissions = Array.prototype.slice
      .call(dialog.querySelectorAll("input[type=checkbox]:checked"))
      .map(function (c) {
        return c.value;
      });
    state.dialogOpen = false;
    addApp.focus();
    scheduleChangeDetection();
  });
  invite.addEventListener("click", function () {
    if (!invite.disabled) {
      state.invited = state.email.committed;
      scheduleChangeDetection();
    }
  });

  // React-style: one focusout listener at the root commits the field.
  app.addEventListener("focusout", function (e) {
    if (e.target === name) {
      state.displayName.committed = name.value;
      state.displayName.commits++;
      scheduleChangeDetection();
    }
  });

  // The combobox: typing opens the filtered list; an option keeps focus in the
  // input on mousedown and is picked on click; blur closes the list and drops
  // a query that was not picked.
  function renderCities() {
    cityList.innerHTML = "";
    if (!state.city.open) {
      return;
    }
    CITIES.filter(function (c) {
      return c.toLowerCase().indexOf(state.city.query.toLowerCase()) === 0;
    }).forEach(function (c) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.textContent = c;
      li.addEventListener("mousedown", function (e) {
        e.preventDefault();
      });
      li.addEventListener("click", function () {
        state.city.value = c;
        state.city.query = c;
        city.value = c;
        state.city.open = false;
        renderCities();
        scheduleChangeDetection();
      });
      cityList.appendChild(li);
    });
  }
  city.addEventListener("input", function () {
    state.city.query = city.value;
    state.city.open = city.value !== "";
    renderCities();
    scheduleChangeDetection();
  });
  city.addEventListener("blur", function () {
    state.city.open = false;
    if (state.city.value !== state.city.query) {
      state.city.query = state.city.value || "";
      city.value = state.city.query;
    }
    renderCities();
    scheduleChangeDetection();
  });

  search.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      state.searched = search.value;
      scheduleChangeDetection();
    }
  });

  ["focus", "blur", "focusin", "focusout"].forEach(function (type) {
    app.addEventListener(
      type,
      function (e) {
        const t = e.target;
        if (t && t.id && t.localName === "input") {
          state.events.push(type + ":" + t.id + ":" + (e.isTrusted ? "t" : "u"));
          scheduleChangeDetection();
        }
      },
      true
    );
  });

  state.ready = true;
  detectChanges();
})();
