import type { PublicAuctionView } from "@bike/contracts";
import { describe, expect, it } from "vitest";
import {
  announcementFor,
  baseTitle,
  flashStep,
  outcomeCopy,
  OUTBID_PREFIX,
  snapEquals,
  softCloseActive,
  titleFor,
  trackExtension,
  type AnnounceSnap,
  type ExtensionTrack,
} from "./logic";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 14, 16, 0); // 9:30 PM IST

const view = (over: Partial<PublicAuctionView> = {}): PublicAuctionView => ({
  auctionId: "a1",
  status: "LIVE",
  outcome: null,
  startsAt: T0 - 60 * MIN,
  closesAt: T0,
  startPriceMinor: 5_000_000,
  currentPriceMinor: 5_050_000,
  minNextBidMinor: 5_100_000,
  bidCount: 2,
  hasReserve: false,
  reserveMet: false,
  leadingBidder: "Bidder K7Q2",
  extensionCount: 0,
  seq: 3,
  viewer: { isLeading: false, isWinner: false },
  ...over,
});

describe("trackExtension: the '+2:00 extended' chip", () => {
  it("is silent on first sight and when nothing changed", () => {
    const first = trackExtension(null, view());
    expect(first.extendedByMs).toBeNull();
    const again = trackExtension(first.track, view({ seq: 4, bidCount: 3 }));
    expect(again.extendedByMs).toBeNull();
    expect(again.track).toBe(first.track); // same object: no state update needed
  });
  it("reports how far the deadline moved when the extension count goes up", () => {
    const t0 = trackExtension(null, view()).track;
    const r = trackExtension(t0, view({ closesAt: T0 + 2 * MIN, extensionCount: 1 }));
    expect(r.extendedByMs).toBe(2 * MIN);
    expect(r.track).toEqual({ auctionId: "a1", closesAt: T0 + 2 * MIN, extensionCount: 1 });
  });
  it("measures from the pre-extension deadline even if bid.accepted moved closesAt a render earlier", () => {
    let track: ExtensionTrack = trackExtension(null, view()).track;
    // render 1: bid.accepted applied (closesAt already extended), extensionCount not yet bumped
    let r = trackExtension(track, view({ closesAt: T0 + 45_000 }));
    expect(r.extendedByMs).toBeNull();
    track = r.track;
    // render 2: auction.extended applied
    r = trackExtension(track, view({ closesAt: T0 + 45_000, extensionCount: 1 }));
    expect(r.extendedByMs).toBe(45_000);
  });
  it("sums several extensions missed while reconnecting; resets for another auction", () => {
    const t0 = trackExtension(null, view()).track;
    expect(
      trackExtension(t0, view({ closesAt: T0 + 3 * MIN, extensionCount: 2 })).extendedByMs,
    ).toBe(3 * MIN);
    const other = trackExtension(t0, view({ auctionId: "a2", extensionCount: 5 }));
    expect(other.extendedByMs).toBeNull();
    expect(other.track.auctionId).toBe("a2");
  });
  it("never reports a non-positive move", () => {
    const t0 = trackExtension(null, view()).track;
    expect(trackExtension(t0, view({ closesAt: T0, extensionCount: 1 })).extendedByMs).toBeNull();
  });
});

describe("softCloseActive", () => {
  it("only in the final window, while LIVE, once anti-sniping is proven on", () => {
    const v = view({ extensionCount: 1 });
    expect(softCloseActive(v, T0 - 2 * MIN - 1)).toBe(false);
    expect(softCloseActive(v, T0 - 2 * MIN)).toBe(true);
    expect(softCloseActive(v, T0 - 1)).toBe(true);
    expect(softCloseActive(v, T0)).toBe(false); // closing: the server decides
    expect(softCloseActive(view(), T0 - MIN)).toBe(false); // no extension yet: unknown
    expect(softCloseActive(view({ extensionCount: 1, status: "ENDED" }), T0 - MIN)).toBe(false);
  });
});

describe("outbid title flash", () => {
  it("alternates the prefix while flashing and strips a leftover prefix", () => {
    const s = { flashing: true };
    expect(titleFor("Bike auction", s, 0)).toBe(`${OUTBID_PREFIX}Bike auction`);
    expect(titleFor("Bike auction", s, 1)).toBe("Bike auction");
    expect(titleFor("Bike auction", { flashing: false }, 0)).toBe("Bike auction");
    expect(baseTitle(`${OUTBID_PREFIX}Bike auction`)).toBe("Bike auction");
    expect(baseTitle("Bike auction")).toBe("Bike auction");
  });
  it("keeps flashing in a hidden tab; stops on the first interaction with the visible page", () => {
    let s = { flashing: true };
    s = flashStep(s, { type: "tick" });
    expect(s.flashing).toBe(true);
    s = flashStep(s, { type: "interact", visible: false });
    expect(s.flashing).toBe(true);
    s = flashStep(s, { type: "interact", visible: true });
    expect(s.flashing).toBe(false);
    expect(flashStep(s, { type: "interact", visible: true })).toBe(s);
  });
});

describe("announcementFor: the single polite live region", () => {
  const snap = (over: Partial<AnnounceSnap> = {}): AnnounceSnap => ({
    auctionId: "a1",
    status: "LIVE",
    outcomeHeadline: null,
    outbidMinMinor: null,
    extensionCount: 0,
    closesAt: T0,
    acceptedBidId: null,
    acceptedAmountMinor: null,
    ...over,
  });
  it("says nothing on first paint or for unrelated changes (e.g. the clock)", () => {
    expect(announcementFor(null, snap())).toBeNull();
    expect(announcementFor(snap(), snap({ closesAt: T0 + 1 }))).toBeNull();
    expect(snapEquals(snap(), snap())).toBe(true);
  });
  it("announces outbid once, with the new minimum", () => {
    expect(announcementFor(snap(), snap({ outbidMinMinor: 5_100_000 }))).toBe(
      "You've been outbid. Minimum now ₹51,000.",
    );
    expect(
      announcementFor(snap({ outbidMinMinor: 5_100_000 }), snap({ outbidMinMinor: 5_150_000 })),
    ).toBeNull();
  });
  it("announces accepted bids, extensions and the end", () => {
    expect(
      announcementFor(snap(), snap({ acceptedBidId: "b1", acceptedAmountMinor: 5_100_000 })),
    ).toBe("Your bid of ₹51,000 was accepted.");
    expect(announcementFor(snap(), snap({ extensionCount: 1, closesAt: T0 + 2 * MIN }))).toBe(
      "Late bid: the auction was extended. It now ends at 9:32 PM IST.",
    );
    expect(
      announcementFor(
        snap(),
        snap({ status: "ENDED", outcomeHeadline: "Sold to Bidder K7Q2 for ₹50,500." }),
      ),
    ).toBe("The auction has ended. Sold to Bidder K7Q2 for ₹50,500.");
    expect(announcementFor(snap(), snap({ status: "CANCELLED" }))).toBe(
      "This auction was cancelled.",
    );
  });
  it("joins simultaneous changes", () => {
    expect(
      announcementFor(
        snap(),
        snap({ acceptedBidId: "b1", acceptedAmountMinor: 5_100_000, extensionCount: 1 }),
      ),
    ).toMatch(/^Your bid of ₹51,000 was accepted\. Late bid: /);
  });
});

describe("outcomeCopy: the ended card", () => {
  it("winner, other bidders, reserve not met, no bids, cancelled", () => {
    const sold = view({ status: "ENDED", outcome: "SOLD", currentPriceMinor: 4_000_000 });
    expect(outcomeCopy({ ...sold, viewer: { isLeading: true, isWinner: true } })?.headline).toBe(
      "You won at ₹40,000.",
    );
    expect(outcomeCopy(sold)?.headline).toBe("Sold to Bidder K7Q2 for ₹40,000.");
    const rnm = outcomeCopy(view({ status: "ENDED", outcome: "RESERVE_NOT_MET" }));
    expect(rnm?.headline).toBe("Reserve not met. Not sold.");
    expect(rnm?.detail).toMatch(/₹50,500, was below the seller's reserve/);
    expect(
      outcomeCopy(view({ status: "ENDED", outcome: "NO_BIDS", currentPriceMinor: null }))?.detail,
    ).toBe("Nobody bid at the starting price of ₹50,000.");
    expect(outcomeCopy(view({ status: "CANCELLED" }))?.headline).toMatch(/cancelled/);
    expect(outcomeCopy(view())).toBeNull();
  });
});
