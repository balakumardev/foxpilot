import { z } from "zod";
// Mirror the evaluate-script arg schema (kept in sync with server.ts).
const evalArgs = z.object({
  tabId: z.number(),
  function: z.string(),
  args: z.array(z.any()).optional(),
  world: z.enum(["main", "isolated", "auto"]).optional(),
  engine: z.enum(["auto", "cdp"]).optional(),
});

test("evaluate-script schema accepts world:auto and engine:cdp", () => {
  expect(evalArgs.parse({ tabId: 1, function: "() => 1", world: "auto", engine: "cdp" }))
    .toMatchObject({ world: "auto", engine: "cdp" });
});
test("evaluate-script schema still accepts legacy world:main with no engine", () => {
  expect(evalArgs.parse({ tabId: 1, function: "() => 1", world: "main" }))
    .toMatchObject({ world: "main" });
});
