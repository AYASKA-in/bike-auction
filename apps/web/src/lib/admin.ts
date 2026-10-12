import { PublicBike } from "@bike/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { apiGet } from "./api";

export const AdminBikeRow = z.object({
  id: z.string(),
  make: z.string(),
  model: z.string(),
  variant: z.string().nullable(),
  manufactureYear: z.number(),
  city: z.string(),
  kmDriven: z.number(),
  repossessed: z.boolean(),
  inspectionGrade: z.string().nullable(),
  imageCount: z.number(),
  coverUrl: z.string().nullable(),
  openAuctionId: z.string().nullable(),
  updatedAt: z.number(),
});
export const adminBikesQuery = queryOptions({
  queryKey: ["admin", "bikes"],
  queryFn: ({ signal }) =>
    apiGet(
      "/admin/bikes",
      (x) => z.object({ items: z.array(AdminBikeRow) }).parse(x).items,
      signal,
    ),
});

export const AdminBikeDetail = z.object({
  bike: PublicBike,
  lockedReason: z.string().nullable(),
  auctions: z.array(
    z.object({
      auctionId: z.string(),
      active: z.number(),
      status: z.string().nullable(),
      startsAt: z.number().nullable(),
      closesAt: z.number().nullable(),
    }),
  ),
});
export const adminBikeQuery = (id: string) =>
  queryOptions({
    queryKey: ["admin", "bike", id],
    queryFn: ({ signal }) => apiGet(`/admin/bikes/${id}`, (x) => AdminBikeDetail.parse(x), signal),
  });

export const AdminAuctionRow = z.object({
  auctionId: z.string(),
  title: z.string(),
  bikeId: z.string(),
  status: z.enum(["DRAFT", "SCHEDULED", "LIVE", "ENDED", "CANCELLED"]),
  outcome: z.enum(["SOLD", "RESERVE_NOT_MET", "NO_BIDS"]).nullable(),
  startPriceMinor: z.number(),
  currentPriceMinor: z.number().nullable(),
  bidCount: z.number(),
  startsAt: z.number(),
  closesAt: z.number(),
  hasReserve: z.number(),
});
export type AdminAuctionRow = z.infer<typeof AdminAuctionRow>;
export const adminAuctionsQuery = queryOptions({
  queryKey: ["admin", "auctions"],
  queryFn: ({ signal }) =>
    apiGet(
      "/admin/auctions",
      (x) => z.object({ items: z.array(AdminAuctionRow) }).parse(x).items,
      signal,
    ),
  refetchInterval: 15_000,
});

export const AdminAuctionDetail = z.object({
  state: z.object({
    auctionId: z.string(),
    status: z.string(),
    startPriceMinor: z.number(),
    reserveMinor: z.number().nullable(),
    startsAt: z.number(),
    closesAt: z.number(),
    rules: z.object({ softClose: z.unknown().nullable() }),
  }),
  listing: z.object({ bikeId: z.string(), title: z.string(), terms: z.string() }).nullable(),
});
export const adminAuctionQuery = (id: string) =>
  queryOptions({
    queryKey: ["admin", "auction", id],
    queryFn: ({ signal }) =>
      apiGet(`/admin/auctions/${id}`, (x) => AdminAuctionDetail.parse(x), signal),
  });
