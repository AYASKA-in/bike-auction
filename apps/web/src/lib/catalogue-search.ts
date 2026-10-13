import { ListSort, ListStatus } from "@bike/contracts";
import { z } from "zod";

/** URL search params of /auctions (kept outside the lazily loaded route module). */
const num = z.coerce.number().int().nonnegative().optional().catch(undefined);
export const CatalogueSearch = z.object({
  status: ListStatus.optional().catch(undefined),
  sort: ListSort.optional().catch(undefined),
  make: z.string().max(40).optional().catch(undefined),
  q: z.string().max(60).optional().catch(undefined),
  city: z.string().max(60).optional().catch(undefined),
  yearMin: num,
  yearMax: num,
  ccMin: num,
  ccMax: num,
  priceMin: num,
  priceMax: num,
});
