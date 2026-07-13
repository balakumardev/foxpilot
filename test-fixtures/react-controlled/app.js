// Real React app (no JSX / no build) that renders every control surface a
// browser-automation tool tends to BREAK on React SPAs. Every widget is a
// CONTROLLED component: its DOM value is driven by React state, and the only
// way to change it is to make React's synthetic event fire. If an automation
// tool sets `input.value` directly (bypassing React's value tracker) the echo
// and the #state-mirror stay unchanged — that is the reproduction signal.
(function () {
  var e = React.createElement;
  var useState = React.useState;

  var FRUITS = ["Apple", "Apricot", "Banana", "Blueberry", "Cherry", "Grape", "Mango", "Orange"];

  function App() {
    var textState = useState("");
    var text = textState[0], setText = textState[1];
    var areaState = useState("");
    var area = areaState[0], setArea = areaState[1];
    var selState = useState("none");
    var sel = selState[0], setSel = selState[1];
    var checkState = useState(false);
    var checked = checkState[0], setChecked = checkState[1];
    var radioState = useState("");
    var radio = radioState[0], setRadio = radioState[1];
    var countState = useState(0);
    var count = countState[0], setCount = countState[1];
    var cardState = useState(0);
    var cardClicks = cardState[0], setCardClicks = cardState[1];
    var keyState = useState("");
    var lastKey = keyState[0], setLastKey = keyState[1];
    // Page-world (React) readers of the NATIVE event's legacy keyCode/which and
    // modern code — the oracle for whether a synthetic key event carries key
    // identity across the isolated→page world boundary.
    var keyCodeState = useState(0);
    var lastKeyCode = keyCodeState[0], setLastKeyCode = keyCodeState[1];
    var codeState = useState("");
    var lastCode = codeState[0], setLastCode = codeState[1];
    var chatState = useState("");
    var chat = chatState[0], setChat = chatState[1];
    var searchState = useState("");
    var search = searchState[0], setSearch = searchState[1];
    var fnameState = useState("");
    var fname = fnameState[0], setFname = fnameState[1];
    var lnameState = useState("");
    var lname = lnameState[0], setLname = lnameState[1];
    var submitState = useState(null);
    var submitted = submitState[0], setSubmitted = submitState[1];

    var mirror = {
      text: text, area: area, sel: sel, checked: checked, radio: radio,
      count: count, cardClicks: cardClicks, lastKey: lastKey,
      lastKeyCode: lastKeyCode, lastCode: lastCode, chat: chat,
      search: search, fname: fname, lname: lname, submitted: submitted,
    };

    var filtered = FRUITS.filter(function (f) {
      return f.toLowerCase().indexOf(search.toLowerCase()) !== -1;
    });

    return e("div", null,
      e("h1", null, "React controlled-input fixture"),

      // 1. Controlled text input — fill-element / type-at target
      e("section", null,
        e("h2", null, "1. Controlled text input"),
        e("label", { htmlFor: "text-input" }, "Text"),
        e("input", {
          id: "text-input", type: "text", "data-testid": "text-input",
          "aria-label": "Text input", placeholder: "type here",
          value: text,
          onChange: function (ev) { setText(ev.target.value); },
          onKeyDown: function (ev) {
            setLastKey(ev.key);
            setLastKeyCode(ev.keyCode);
            setLastCode(ev.code);
          },
        }),
        e("div", { className: "echo", id: "text-echo" }, "You typed: " + text + " (len " + text.length + ")")
      ),

      // 2. Controlled textarea
      e("section", null,
        e("h2", null, "2. Controlled textarea"),
        e("textarea", {
          id: "area-input", rows: 3, "data-testid": "area-input", "aria-label": "Textarea",
          value: area,
          onChange: function (ev) { setArea(ev.target.value); },
        }),
        e("div", { className: "echo", id: "area-echo" }, "Area: " + area)
      ),

      // 3. Controlled select — fill-element on a <select>
      e("section", null,
        e("h2", null, "3. Controlled select"),
        e("select", {
          id: "select-input", "data-testid": "select-input", "aria-label": "Select",
          value: sel,
          onChange: function (ev) { setSel(ev.target.value); },
        },
          e("option", { value: "none" }, "None"),
          e("option", { value: "alpha" }, "Alpha"),
          e("option", { value: "beta" }, "Beta"),
          e("option", { value: "gamma" }, "Gamma")
        ),
        e("div", { className: "echo", id: "select-echo" }, "Selected: " + sel)
      ),

      // 4. Controlled checkbox + radio — click that must update React state
      e("section", null,
        e("h2", null, "4. Checkbox + radio"),
        e("label", null,
          e("input", {
            id: "check-input", type: "checkbox", "aria-label": "Agree",
            checked: checked,
            onChange: function (ev) { setChecked(ev.target.checked); },
          }), " Agree"),
        e("div", null,
          ["red", "green", "blue"].map(function (c) {
            return e("label", { key: c, style: { display: "inline-block", marginRight: "10px" } },
              e("input", {
                type: "radio", name: "color", value: c, id: "radio-" + c,
                checked: radio === c,
                onChange: function (ev) { setRadio(ev.target.value); },
              }), " " + c);
          })
        ),
        e("div", { className: "echo", id: "check-echo" }, "checked=" + checked + " radio=" + radio)
      ),

      // 5. onClick counter + role-less cursor:pointer card
      e("section", null,
        e("h2", null, "5. Click targets"),
        e("button", {
          id: "counter-btn", "data-testid": "counter-btn",
          onClick: function () { setCount(function (n) { return n + 1; }); },
        }, "Increment"),
        e("span", { id: "count-echo", style: { marginLeft: "10px" } }, "count: " + count),
        e("div", { style: { marginTop: "10px" } },
          // Role-less, no tabindex, handler via React onClick → only cursor:pointer
          // or textContains/selector snapshot surfaces it.
          e("div", {
            id: "card", className: "card",
            onClick: function () { setCardClicks(function (n) { return n + 1; }); },
          }, "Open card"),
          e("span", { id: "card-echo", style: { marginLeft: "10px" } }, "cardClicks: " + cardClicks)
        )
      ),

      // 6. Controlled contenteditable — type-at / press-key on rich input
      e("section", null,
        e("h2", null, "6. Controlled contenteditable"),
        e("div", {
          id: "chat-input", contentEditable: true, suppressContentEditableWarning: true,
          "data-testid": "chat-input", "aria-label": "Message input",
          onInput: function (ev) { setChat(ev.currentTarget.textContent); },
        }),
        e("div", { className: "echo", id: "chat-echo" }, "chat: " + chat)
      ),

      // 7. Live search filter — the classic "React never saw the keystrokes" tell
      e("section", null,
        e("h2", null, "7. Live search filter"),
        e("input", {
          id: "search-input", type: "text", "data-testid": "search-input",
          "aria-label": "Search fruit", placeholder: "filter fruit",
          value: search,
          onChange: function (ev) { setSearch(ev.target.value); },
        }),
        e("ul", { id: "search-results" },
          filtered.map(function (f) { return e("li", { key: f }, f); })
        )
      ),

      // 8. Multi-field form + submit — fill-form target
      e("section", null,
        e("h2", null, "8. Form submit"),
        e("form", {
          id: "the-form",
          onSubmit: function (ev) { ev.preventDefault(); setSubmitted({ fname: fname, lname: lname }); },
        },
          e("label", { htmlFor: "fname-input" }, "First name"),
          e("input", { id: "fname-input", type: "text", "aria-label": "First name", value: fname,
            onChange: function (ev) { setFname(ev.target.value); } }),
          e("label", { htmlFor: "lname-input" }, "Last name"),
          e("input", { id: "lname-input", type: "text", "aria-label": "Last name", value: lname,
            onChange: function (ev) { setLname(ev.target.value); } }),
          e("button", { id: "submit-btn", type: "submit", style: { marginTop: "8px" } }, "Submit")
        ),
        e("div", { className: "echo", id: "form-echo" },
          submitted ? "Submitted: " + submitted.fname + " " + submitted.lname : "not submitted")
      ),

      // State oracle — assert against this to know if React actually saw an action.
      e("section", null,
        e("h2", null, "React state mirror"),
        e("pre", { id: "state-mirror", "data-testid": "state-mirror" }, JSON.stringify(mirror, null, 2))
      )
    );
  }

  var root = ReactDOM.createRoot(document.getElementById("root"));
  root.render(e(App));
})();
