// Formats a point-action-result for the coordinate tools (click-at / type-at):
// a one-line confirmation with the element descriptor (and a "(page navigated)"
// note when the click began a navigation), or isError:true on a miss. Extracted
// from server.ts so it is a pure, side-effect-free function that can be imported
// and unit-tested directly (server.ts self-executes on import — it constructs
// the BrowserAPI, connects stdio, and wires process exit — so it cannot be
// imported into a test).
export function formatPointResult(
  verb: string,
  tabId: number,
  x: number,
  y: number,
  result: {
    ok: boolean;
    error?: string;
    // Set true when the click began a navigation that tore down the page before
    // the descriptor could be captured (so `element` may be absent). Append-only.
    navigated?: boolean;
    element?: {
      tag: string;
      id?: string;
      name?: string;
      role?: string;
      editable?: boolean;
    };
  }
) {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: `${verb} failed at (${x}, ${y}) on tab ${tabId}: ${
            result.error ?? "no element at point"
          }`,
        },
      ],
      isError: true,
    };
  }
  const el = result.element;
  const desc = el
    ? ` — element: <${el.tag}${el.id ? " #" + el.id : ""}${
        el.role ? ' role="' + el.role + '"' : ""
      }>${el.name ? ' "' + el.name + '"' : ""}${el.editable ? " (editable)" : ""}`
    : "";
  const nav = result.navigated ? " (page navigated)" : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `${verb} at (${x}, ${y}) on tab ${tabId}${desc}${nav}`,
      },
    ],
  };
}
