// Formats the click-element reply text: the confirmation, the descendant a
// retargeted click was dispatched on, the "(page navigated)" note and the
// interception warning. Extracted from server.ts so it is a pure,
// side-effect-free function that can be imported and unit-tested directly
// (server.ts self-executes on import — see point-format.ts).
export function formatClickResult(
  uid: string,
  doubleClick: boolean | undefined,
  result: {
    navigated?: boolean;
    intercepted?: {
      tag: string;
      id?: string;
      classes?: string;
      role?: string;
      name?: string;
    };
    // Set when the click went to an interactive descendant of the uid element
    // (e.g. the <button> inside a role="menuitem" wrapper) instead of the uid
    // element itself.
    dispatchedTo?: { tag: string; name?: string };
    // Set when the clicked control is disabled: the click activated nothing.
    disabled?: boolean;
  }
): string {
  const verb = doubleClick ? "Double-clicked" : "Clicked";
  let text = `${verb} element ${uid}`;
  if (result.dispatchedTo) {
    const d = result.dispatchedTo;
    const raw = d.name || "";
    const name = raw.length > 60 ? raw.slice(0, 59) + "…" : raw;
    text += ` (dispatched on its descendant <${d.tag}>${
      name ? " " + JSON.stringify(name) : ""
    })`;
  }
  if (result.navigated) {
    text += " (page navigated)";
  }
  if (result.disabled) {
    // The press still took focus off the field being edited, as a real click
    // does, and a form that registers a field when you leave it may enable
    // the control because of that.
    text +=
      "\nThe element is disabled, so the click did nothing. It still took focus off the field you were editing, which can enable it: take a fresh snapshot and click again if it is enabled now.";
  }
  if (result.intercepted) {
    // Selector rule mirrors the injected selectorFor(): #id → tag.firstClass → tag.
    const intercepted = result.intercepted;
    const sel = intercepted.id
      ? `#${intercepted.id}`
      : intercepted.classes
        ? `${intercepted.tag}.${intercepted.classes.split(" ")[0]}`
        : intercepted.tag;
    text += `\n⚠ click may be intercepted by ${sel} — consider dismiss-overlays`;
  }
  return text;
}
