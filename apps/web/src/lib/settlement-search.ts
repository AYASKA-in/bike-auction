import { z } from "zod";

/** URL search for /admin/settlements (kept out of the lazy page chunk; the router needs it). */
export const SettlementsSearch = z.object({
  status: z
    .enum(["open", "awaiting_verification", "overdue_soon", "paid", "closed", "all"])
    .optional()
    .catch(undefined),
});
