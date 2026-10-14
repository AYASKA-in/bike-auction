import { MyBidsPage, MyBidsTab, Watchlist, WatchlistIds, WATCHLIST_MAX } from "@bike/contracts";
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { ApiError, apiGet, apiSend } from "./api";

/**
 * Buyer self-service queries ("My bids", "Watchlist"). Keys are scoped by user id, so switching
 * accounts in one tab can never show the previous account's cached lists.
 */
export const mineKey = (userId: string) => ["mine", userId] as const;

export const MY_BIDS_TABS: { value: MyBidsTab; label: string }[] = [
  { value: "leading", label: "Leading" },
  { value: "outbid", label: "Outbid" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

/** URL search for /me/bids. An unknown or missing tab falls back to "leading" (never throws). */
export const MyBidsSearch = z.object({
  tab: MyBidsTab.optional().catch(undefined),
});
export const parseMyBidsTab = (raw: unknown): MyBidsTab => {
  const r = MyBidsTab.safeParse(raw);
  return r.success ? r.data : "leading";
};

/** Next/previous tab for arrow-key navigation in the tablist (wraps around). */
export function adjacentTab(current: MyBidsTab, delta: 1 | -1): MyBidsTab {
  const order = MY_BIDS_TABS.map((t) => t.value);
  const i = order.indexOf(current);
  return order[(i + delta + order.length) % order.length]!;
}

export const myBidsQuery = (userId: string, tab: MyBidsTab, limit = 12) =>
  infiniteQueryOptions({
    queryKey: [...mineKey(userId), "bids", tab, limit],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ tab, limit: String(limit) });
      if (pageParam) p.set("cursor", pageParam);
      return apiGet(`/me/bids?${p.toString()}`, (x) => MyBidsPage.parse(x), signal);
    },
    getNextPageParam: (last) => last.nextCursor,
    // Read-model backed: one light request every 30 s while the tab is visible (TanStack pauses
    // intervals in background tabs), and on focus/reconnect.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

export const watchlistQuery = (userId: string) =>
  queryOptions({
    queryKey: [...mineKey(userId), "watchlist"],
    queryFn: ({ signal }) => apiGet("/me/watchlist", (x) => Watchlist.parse(x), signal),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

export const watchlistIdsQuery = (userId: string) =>
  queryOptions({
    queryKey: [...mineKey(userId), "watchlist-ids"],
    queryFn: ({ signal }) => apiGet("/me/watchlist/ids", (x) => WatchlistIds.parse(x), signal),
    staleTime: 60_000,
  });

/** Pure: the id list after (un)watching, without duplicates; newest first like the server. */
export function withWatched(ids: readonly string[], auctionId: string, watch: boolean): string[] {
  const rest = ids.filter((id) => id !== auctionId);
  return watch ? [auctionId, ...rest] : rest;
}

let dueTimer: ReturnType<typeof setTimeout> | undefined;
/** A card's deadline passed: refetch "my" lists once, shortly after (coalesces many cards). */
export function refreshMineSoon(qc: QueryClient, userId: string): void {
  if (dueTimer !== undefined) return;
  dueTimer = setTimeout(() => {
    dueTimer = undefined;
    void qc.invalidateQueries({ queryKey: mineKey(userId) });
  }, 2_500);
}

type Toggle = { auctionId: string; watch: boolean };
type Snapshot = { ids: WatchlistIds | undefined; list: Watchlist | undefined };

/**
 * Optimistic watch/unwatch: the button flips (and an unwatched card leaves the watchlist page)
 * immediately; on error both caches roll back. Both caches are re-synced from the server after.
 */
export function useToggleWatch(userId: string) {
  const qc = useQueryClient();
  const idsKey = watchlistIdsQuery(userId).queryKey;
  const listKey = watchlistQuery(userId).queryKey;
  return useMutation<void, unknown, Toggle, Snapshot>({
    mutationFn: ({ auctionId, watch }) =>
      apiSend(watch ? "PUT" : "DELETE", `/me/watchlist/${auctionId}`, undefined, () => undefined),
    onMutate: async ({ auctionId, watch }) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: idsKey }),
        qc.cancelQueries({ queryKey: listKey }),
      ]);
      const snapshot: Snapshot = { ids: qc.getQueryData(idsKey), list: qc.getQueryData(listKey) };
      qc.setQueryData(idsKey, (old) => ({
        ids: withWatched(old?.ids ?? [], auctionId, watch),
        max: old?.max ?? WATCHLIST_MAX,
      }));
      if (!watch && snapshot.list) {
        qc.setQueryData(listKey, {
          items: snapshot.list.items.filter((i) => i.auctionId !== auctionId),
        });
      }
      return snapshot;
    },
    onError: (_err, _vars, snapshot) => {
      if (!snapshot) return;
      qc.setQueryData(idsKey, snapshot.ids);
      qc.setQueryData(listKey, snapshot.list);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: idsKey });
      void qc.invalidateQueries({ queryKey: listKey });
    },
  });
}

/** Maps watchlist errors to human copy (never raw server text for unknown codes). */
export function watchErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Couldn't update your watchlist. Try again.";
  switch (err.code) {
    case "CONFLICT":
      return `Your watchlist is full (${WATCHLIST_MAX}). Remove one to add another.`;
    case "NOT_FOUND":
      return "This auction can't be watched.";
    case "RATE_LIMITED":
      return "You're changing your watchlist very fast. Try again in a few seconds.";
    case "AUTH_REQUIRED":
      return "Your session ended. Sign in again.";
    case "NETWORK":
      return "Can't reach the server. Check your connection.";
    default:
      return "Couldn't update your watchlist. Try again.";
  }
}
