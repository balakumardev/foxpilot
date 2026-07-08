import { z } from "zod";
const dismissArgs = z.object({ tabId: z.number() });
test("dismiss-overlays schema accepts tabId", () => {
  expect(dismissArgs.parse({ tabId: 3 })).toMatchObject({ tabId: 3 });
});
