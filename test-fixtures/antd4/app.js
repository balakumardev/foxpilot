/*
 * antd 4.x fixture — the two component shapes that broke FoxPilot's synthetic
 * input path on a real antd app, reproduced offline.
 *
 *  - Select mode="multiple" (.ant-select-multiple): a portaled, VIRTUALISED
 *    (rc-virtual-list) dropdown whose trigger toggles open/closed. Reproduces
 *    D1 (select-option against an ALREADY-OPEN multi-select).
 *  - Checkbox / Checkbox.Group: a CONTROLLED React checkbox whose real
 *    <input type="checkbox"> is visually hidden (opacity:0) under a painted
 *    .ant-checkbox-inner span. Reproduces D2 (synthetic click reports success
 *    but .checked stays false).
 *
 * Every piece of state is echoed into #state-mirror as JSON so a test can assert
 * what REACT actually committed, not merely what the DOM looks like — the whole
 * point of these defects is that the tool reported success while the app's state
 * never moved.
 */
(function () {
  var e = React.createElement;
  var useState = React.useState;
  var Select = antd.Select;
  var Checkbox = antd.Checkbox;

  var COUNTRIES = [
    "India",
    "Indonesia",
    "Ireland",
    "Israel",
    "Italy",
    "Japan",
    "Kenya",
    "Latvia",
    "Mexico",
    "Nepal",
    "Norway",
    "Peru",
    "Poland",
    "Portugal",
    "Qatar",
    "Romania",
    "Rwanda",
    "Senegal",
    "Serbia",
    "Spain",
  ];

  var PERMISSIONS = ["read", "write", "admin"];

  function App() {
    // D1: multi-select. Starts EMPTY; the test opens the dropdown itself so the
    // "menu already open" precondition is genuine rather than simulated.
    var multi = useState([]);
    var multiValue = multi[0];
    var setMultiValue = multi[1];

    // A single-value Select alongside it, so a fix for the multiple case can be
    // shown NOT to regress the single case (which already worked).
    var single = useState(undefined);
    var singleValue = single[0];
    var setSingleValue = single[1];

    // D2: controlled checkbox group with one box ALREADY checked, matching the
    // live app (proves the group is wired and the unchecked sibling is live,
    // not disabled).
    var perms = useState(["read"]);
    var permValue = perms[0];
    var setPermValue = perms[1];

    // D2: a standalone controlled checkbox (no group wrapper).
    var tos = useState(false);
    var tosChecked = tos[0];
    var setTosChecked = tos[1];

    var mirror = {
      multiSelect: multiValue,
      singleSelect: singleValue === undefined ? null : singleValue,
      permissions: permValue,
      acceptedTos: tosChecked,
    };

    return e(
      "div",
      null,
      e("h1", null, "antd 4.x fixture"),

      e(
        "section",
        null,
        e("h2", null, "D1 — Select mode=\"multiple\" (portaled, virtualised)"),
        e(Select, {
          id: "multi-select",
          mode: "multiple",
          allowClear: true,
          style: { width: "100%" },
          placeholder: "Pick countries",
          value: multiValue,
          onChange: setMultiValue,
          // Keep the portal in the document body (antd's default) so the test
          // exercises the real portal path rather than an inline menu.
          options: COUNTRIES.map(function (c) {
            return { label: c, value: c };
          }),
        })
      ),

      e(
        "section",
        null,
        e("h2", null, "Control — single Select (already worked)"),
        e(Select, {
          id: "single-select",
          style: { width: "100%" },
          placeholder: "Pick one country",
          value: singleValue,
          onChange: setSingleValue,
          options: COUNTRIES.map(function (c) {
            return { label: c, value: c };
          }),
        })
      ),

      e(
        "section",
        null,
        e("h2", null, "D2 — Checkbox.Group (one sibling pre-checked)"),
        e(Checkbox.Group, {
          id: "perm-group",
          value: permValue,
          onChange: setPermValue,
          options: PERMISSIONS.map(function (p) {
            return { label: p, value: p };
          }),
        })
      ),

      e(
        "section",
        null,
        e("h2", null, "D2 — standalone controlled Checkbox"),
        e(
          Checkbox,
          {
            id: "tos-checkbox",
            checked: tosChecked,
            onChange: function (ev) {
              setTosChecked(ev.target.checked);
            },
          },
          "I accept the terms"
        )
      ),

      e(
        "section",
        null,
        e("h2", null, "React state mirror"),
        e("pre", { id: "state-mirror" }, JSON.stringify(mirror, null, 2))
      )
    );
  }

  ReactDOM.createRoot(document.getElementById("root")).render(e(App));
})();
