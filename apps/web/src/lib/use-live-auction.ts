import { BidHistoryPage, type PublicAuctionView } from "@bike/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { apiGet } from "./api";
import { initialLive, type LiveState } from "./live-auction";
import {
  acquireFeed,
  releaseFeed,
  type FeedDeps,
  peekFeed,
  type LiveFeed,
  type SocketLike,
} from "./live-feed";

/** Real browser dependencies for LiveFeed (tests inject fakes instead). */
export const browserFeedDeps: FeedDeps = {
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  url: (id) =>
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/auctions/${encodeURIComponent(id)}/stream`,
  fetchHistory: (id, beforeSeq) =>
    apiGet(
      `/auctions/${encodeURIComponent(id)}/bids?limit=20${beforeSeq ? `&beforeSeq=${beforeSeq}` : ""}`,
      (x) => BidHistoryPage.parse(x),
    ),
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (t) => window.clearTimeout(t as number),
  isOnline: () => navigator.onLine !== false,
  isVisible: () => document.visibilityState === "visible",
  on: (type, fn) => {
    const target: EventTarget = type === "visibilitychange" ? document : window;
    target.addEventListener(type, fn);
    return () => target.removeEventListener(type, fn);
  },
};

/**
 * Live state for one auction. All components on the page share one socket (registry, refcounted):
 * subscribing acquires it, unsubscribing releases it, and leaving the page closes it.
 * `seed` (an HTTP view) is applied only if it is not older than what the socket delivered.
 */
export function useLiveAuction(
  auctionId: string,
  seed: PublicAuctionView | undefined,
): { state: LiveState; feed: LiveFeed | null } {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const feed = acquireFeed(auctionId, browserFeedDeps);
      const off = feed.subscribe(onChange);
      onChange(); // the feed may already hold state from an earlier mount
      return () => {
        off();
        releaseFeed(auctionId, browserFeedDeps);
      };
    },
    [auctionId],
  );
  const getSnapshot = useCallback(
    () => peekFeed(auctionId)?.getState() ?? initialLive,
    [auctionId],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, () => initialLive);
  const feed = state === initialLive ? null : peekFeed(auctionId);

  useEffect(() => {
    if (seed && seed.auctionId === auctionId) peekFeed(auctionId)?.seed(seed);
  }, [seed, auctionId, feed]);

  return { state, feed };
}
