import { z } from "zod";
const selectArgs = z.object({
  tabId: z.number(),
  uid: z.string(),
  option: z.string(),
  exact: z.boolean().optional(),
});
test("select-option schema accepts uid+option (+optional exact)", () => {
  expect(selectArgs.parse({ tabId: 1, uid: "e5", option: "India" }))
    .toMatchObject({ uid: "e5", option: "India" });
  expect(selectArgs.parse({ tabId: 1, uid: "e5", option: "IN", exact: true }).exact).toBe(true);
});
