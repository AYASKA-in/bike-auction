import { PlaceBidResult, type PublicAuctionView } from "@bike/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiPost } from "@/lib/api";
import { BidIntent, isUncertain, minFromError } from "@/lib/bid-intent";
import type { LiveFeed } from "@/lib/live-feed";
import { useMe } from "@/lib/session";

/**
 * One bid pipeline for the whole page: the form, the outbid banner's one-tap rebid and the mobile
 * bar all go through the same mutation, idempotency intent and error handling. Success is shown
 * only after the server's 201; an uncertain failure is retried only by the user, with the same key.
 */
export function useBidController(auctionId: string, feed: LiveFeed | null) {
  const me = useMe();
  const qc = useQueryClient();
  const [intent] = useState(() => new BidIntent());
  const bid = useMutation({
    mutationFn: (amountMinor: number) =>
      apiPost(
        `/auctions/${auctionId}/bids`,
        { amountMinor },
        (x) => PlaceBidResult.parse(x),
        { "idempotency-key": intent.keyFor(amountMinor) },
        15_000,
      ),
    retry: false, // never automatic: an uncertain failure is retried only by the user, same key
    onSuccess: (r) => {
      intent.settle(null);
      feed?.noteOwnBid(r);
      void qc.invalidateQueries({ queryKey: ["view", auctionId] });
    },
    onError: (e) => {
      intent.settle(e);
      if (e instanceof ApiError && e.code === "AUTH_REQUIRED")
        void qc.invalidateQueries({ queryKey: ["me"] });
      if (!isUncertain(e)) void qc.invalidateQueries({ queryKey: ["view", auctionId] });
    },
  });

  const user = me.data ?? null;
  const place = (amountMinor: number) => {
    if (bid.isPending) return;
    bid.mutate(amountMinor);
  };
  /**
   * The minimum to offer: the live view's, or the higher one a BID_TOO_LOW rejection just told us
   * (the socket may deliver the new price a moment later).
   */
  const minFor = (view: PublicAuctionView) =>
    Math.max(view.minNextBidMinor ?? view.startPriceMinor, minFromError(bid.error) ?? 0);
  const retryAmount = bid.isError && isUncertain(bid.error) ? intent.pendingRetryAmount : null;

  return {
    user,
    /** Signed-in buyer (admins can't bid; anonymous visitors are asked to sign in). */
    canBid: user !== null && user.role !== "ADMIN",
    bid,
    place,
    minFor,
    retryAmount,
  };
}

export type BidController = ReturnType<typeof useBidController>;
