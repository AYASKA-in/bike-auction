import type { PublicAuctionView } from "@bike/contracts";
import { DEFAULT_SOFT_CLOSE } from "@bike/domain";
import { formatINR, formatISTClock } from "@/lib/format";

/**
 * Pure helpers for the live auction page (no React, no DOM) so they're unit-tested in node.
 */

// --- soft-close extension chip -------------------------------------------------------------------

/** What we remember between renders to detect an extension. */
export type ExtensionTrack = { auctionId: string; closesAt: number; extensionCount: number };
type ExtView = Pick<PublicAuctionView, "auctionId" | "closesAt" | "extensionCount">;

/**
 * Detects a soft-close extension and by how much the deadline moved.
 *
 * The baseline deadline is only advanced when `extensionCount` changes, because the feed can apply
 * `bid.accepted` (which already carries the extended `closesAt`) and `auction.extended` (which bumps
 * the count) in separate renders: comparing render-to-render would then report +0:00.
 * Returns the same `track` object when nothing changed (cheap equality check for the caller).
 */
export function trackExtension(
  track: ExtensionTrack | null,
  v: ExtView,
): { track: ExtensionTrack; extendedByMs: number | null } {
  if (
    track === null ||
    track.auctionId !== v.auctionId ||
    v.extensionCount < track.extensionCount
  ) {
    const fresh = {
      auctionId: v.auctionId,
      closesAt: v.closesAt,
      extensionCount: v.extensionCount,
    };
    return { track: fresh, extendedByMs: null };
  }
  if (v.extensionCount === track.extensionCount) return { track, extendedByMs: null };
  const delta = v.closesAt - track.closesAt;
  return {
    track: { auctionId: v.auctionId, closesAt: v.closesAt, extensionCount: v.extensionCount },
    extendedByMs: delta > 0 ? delta : null,
  };
}

/**
 * "Soft close active" note: shown in the last window before close. The public view doesn't say
 * whether anti-sniping is enabled for this auction (and contracts are frozen), so we only claim it
 * once an extension has actually happened (extensionCount > 0), which proves it's on.
 */
export function softCloseActive(
  v: Pick<PublicAuctionView, "status" | "closesAt" | "extensionCount">,
  nowMs: number,
  windowMs: number = DEFAULT_SOFT_CLOSE.windowMs,
): boolean {
  const left = v.closesAt - nowMs;
  return v.status === "LIVE" && v.extensionCount > 0 && left > 0 && left <= windowMs;
}

export const SOFT_CLOSE_NOTE = `Soft close active: late bids extend by ${Math.round(DEFAULT_SOFT_CLOSE.extensionMs / 60_000)} min`;

// --- "(Outbid!)" title flash ---------------------------------------------------------------------

export const OUTBID_PREFIX = "(Outbid!) ";

/** The page's own title, without our prefix (in case a previous flash left it behind). */
export const baseTitle = (title: string) =>
  title.startsWith(OUTBID_PREFIX) ? title.slice(OUTBID_PREFIX.length) : title;

export type FlashState = { flashing: boolean };
export type FlashEvent = { type: "tick" } | { type: "interact"; visible: boolean };

/**
 * The flash runs until the bidder interacts with the page while it's visible. Interactions can't
 * happen in a hidden tab, so a backgrounded tab keeps flashing until the bidder comes back and
 * touches the page.
 */
export function flashStep(s: FlashState, e: FlashEvent): FlashState {
  if (e.type === "interact" && e.visible && s.flashing) return { flashing: false };
  return s;
}

/** Title for a given tick: alternates the prefix on and off while flashing. */
export function titleFor(base: string, s: FlashState, tick: number): string {
  return s.flashing && tick % 2 === 0 ? `${OUTBID_PREFIX}${base}` : base;
}

// --- screen-reader announcements -----------------------------------------------------------------

/** The facts the polite live region cares about. Everything else (the clock!) stays silent. */
export type AnnounceSnap = {
  auctionId: string;
  status: PublicAuctionView["status"];
  outcomeHeadline: string | null;
  outbidMinMinor: number | null;
  extensionCount: number;
  closesAt: number;
  acceptedBidId: string | null;
  acceptedAmountMinor: number | null;
};

export function snapEquals(a: AnnounceSnap, b: AnnounceSnap): boolean {
  return (Object.keys(a) as (keyof AnnounceSnap)[]).every((k) => a[k] === b[k]);
}

/** What to say when the snapshot changes, or null. Several changes at once are joined. */
export function announcementFor(prev: AnnounceSnap | null, next: AnnounceSnap): string | null {
  if (prev === null || prev.auctionId !== next.auctionId) return null; // first paint: silent
  const parts: string[] = [];
  if (next.acceptedBidId !== null && next.acceptedBidId !== prev.acceptedBidId)
    parts.push(`Your bid of ${formatINR(next.acceptedAmountMinor ?? 0)} was accepted.`);
  if (next.outbidMinMinor !== null && prev.outbidMinMinor === null)
    parts.push(`You've been outbid. Minimum now ${formatINR(next.outbidMinMinor)}.`);
  if (next.status === "LIVE" && next.extensionCount > prev.extensionCount)
    parts.push(
      `Late bid: the auction was extended. It now ends at ${formatISTClock(next.closesAt)}.`,
    );
  if (next.status !== prev.status && (next.status === "ENDED" || next.status === "CANCELLED"))
    parts.push(
      next.status === "CANCELLED"
        ? "This auction was cancelled."
        : `The auction has ended. ${next.outcomeHeadline ?? ""}`.trim(),
    );
  return parts.length > 0 ? parts.join(" ") : null;
}

// --- ended outcome card --------------------------------------------------------------------------

export type OutcomeCopy = {
  title: string;
  headline: string;
  detail: string | null;
  tone: "won" | "neutral";
};

/** BLUEPRINT §11.3 "Ended": the winner, everyone else, and the unsold cases explained. */
export function outcomeCopy(
  v: Pick<
    PublicAuctionView,
    "status" | "outcome" | "currentPriceMinor" | "startPriceMinor" | "leadingBidder" | "viewer"
  >,
): OutcomeCopy | null {
  if (v.status === "CANCELLED")
    return {
      title: "Auction cancelled",
      headline: "This auction was cancelled. No sale will take place.",
      detail: "Any bids placed on it are void.",
      tone: "neutral",
    };
  if (v.status !== "ENDED" || v.outcome === null) return null;
  const price = v.currentPriceMinor;
  switch (v.outcome) {
    case "SOLD":
      if (v.viewer?.isWinner)
        return {
          title: "You won",
          headline: `You won at ${formatINR(price ?? 0)}. Our team will contact you.`,
          detail: "Payment, paperwork and pickup are arranged directly with our team.",
          tone: "won",
        };
      return {
        title: "Auction ended",
        headline: `Sold to ${v.leadingBidder ?? "the highest bidder"}${price !== null ? ` for ${formatINR(price)}` : ""}.`,
        detail: null,
        tone: "neutral",
      };
    case "RESERVE_NOT_MET":
      return {
        title: "Auction ended",
        headline: "Reserve not met. Not sold.",
        detail:
          price !== null
            ? `The highest bid, ${formatINR(price)}, was below the seller's reserve price (kept private), so the bike wasn't sold.`
            : "Bidding didn't reach the seller's reserve price (kept private), so the bike wasn't sold.",
        tone: "neutral",
      };
    case "NO_BIDS":
      return {
        title: "Auction ended",
        headline: "Ended with no bids.",
        detail: `Nobody bid at the starting price of ${formatINR(v.startPriceMinor)}.`,
        tone: "neutral",
      };
  }
}
