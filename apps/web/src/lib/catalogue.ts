import {
  AuctionDetails,
  AuctionList,
  PublicAuctionView,
  type ListSort,
  type ListStatus,
} from "@bike/contracts";
import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { apiGet } from "./api";

export type CatalogueFilters = {
  status?: ListStatus | undefined;
  sort?: ListSort | undefined;
  make?: string | undefined;
  q?: string | undefined;
  city?: string | undefined;
  yearMin?: number | undefined;
  yearMax?: number | undefined;
  ccMin?: number | undefined;
  ccMax?: number | undefined;
  priceMin?: number | undefined; // rupees in the UI
  priceMax?: number | undefined;
};

function qs(f: CatalogueFilters, extra: Record<string, string> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === "") continue;
    p.set(k, String(k.startsWith("price") ? Number(v) * 100 : v)); // rupees → paise
  }
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

export const catalogueQuery = (f: CatalogueFilters, limit = 12) =>
  infiniteQueryOptions({
    queryKey: ["catalogue", f, limit],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      apiGet(
        `/auctions?${qs(f, { limit: String(limit), ...(pageParam ? { cursor: pageParam } : {}) })}`,
        (x) => AuctionList.parse(x),
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    // Cards never open sockets: one light D1-backed list request every 30 s while visible
    // (TanStack pauses it in background tabs), plus a refetch on focus/reconnect.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let lastRefresh = 0;
/**
 * A card's start/close time passed: refresh the catalogue once, shortly after (the server has
 * resolved the status by then). Coalesces many cards into one request; at most every 5 s.
 */
export function refreshCatalogueSoon(qc: QueryClient): void {
  if (refreshTimer !== undefined) return;
  const wait = Math.max(2_000, lastRefresh + 5_000 - Date.now());
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    lastRefresh = Date.now();
    void qc.invalidateQueries({ queryKey: ["catalogue"] });
  }, wait);
}

const Facets = z.object({ makes: z.array(z.string()), cities: z.array(z.string()) });
export const facetsQuery = queryOptions({
  queryKey: ["facets"],
  queryFn: ({ signal }) => apiGet("/catalogue/facets", (x) => Facets.parse(x), signal),
  staleTime: 5 * 60_000,
});

export const detailsQuery = (id: string) =>
  queryOptions({
    queryKey: ["details", id],
    queryFn: ({ signal }) =>
      apiGet(`/auctions/${id}/details`, (x) => AuctionDetails.parse(x), signal),
  });

export const liveViewQuery = (id: string) =>
  queryOptions({
    queryKey: ["view", id],
    queryFn: ({ signal }) => apiGet(`/auctions/${id}`, (x) => PublicAuctionView.parse(x), signal),
  });
