import { useCallback, useEffect, useState, type RefObject } from "react";
import { Countdown } from "@/components/countdown";
import { Button } from "@/components/ui/button";
import { bidErrorMessage } from "@/lib/bid-intent";
import { formatINR } from "@/lib/format";
import type { LiveState } from "@/lib/live-auction";
import { CheckIcon, WarnIcon } from "./icons";
import { outbidMinimum } from "./live-panel";
import { FlashOnChange } from "./panel-bits";
import type { BidController } from "./use-bid-controller";

/**
 * Mobile sticky bottom bar: price, status and countdown stay reachable while reading the details.
 * When outbid it offers the same one-tap "Bid ₹min" as the panel banner (same bid pipeline).
 */
export function MobileBar({
  live,
  ctl,
  panelRef,
}: {
  live: LiveState;
  ctl: BidController;
  panelRef: RefObject<HTMLElement | null>;
}) {
  const [panelVisible, setPanelVisible] = useState(true);
  const hasView = live.view !== null;
  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setPanelVisible(e?.isIntersecting ?? true));
    io.observe(el);
    return () => io.disconnect();
  }, [panelRef, hasView]);
  const jump = useCallback(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    panelRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    window.setTimeout(
      () => document.getElementById("bid-amount")?.focus({ preventScroll: true }),
      400,
    );
  }, [panelRef]);
  const v = live.view;
  if (!v || panelVisible) return null;
  const isLive = live.status === "live";
  const leading = v.viewer?.isLeading === true && v.status === "LIVE";
  const outbidMin = outbidMinimum(live, ctl);
  const oneTap = outbidMin !== null && ctl.canBid;
  const price = v.currentPriceMinor ?? v.startPriceMinor;
  return (
    <div
      data-testid="mobile-bar"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-pit-ink/10 bg-pit px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-pit-ink shadow-[0_-8px_24px_-12px_#00000080] lg:hidden"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-expanded text-xl leading-tight font-extrabold tnum">
            <FlashOnChange value={price} className="-mx-1 px-1">
              {formatINR(price)}
            </FlashOnChange>
            {!isLive && (
              <span className="ml-2 text-xs font-normal text-caution">may be outdated</span>
            )}
          </p>
          <p className="flex min-w-0 items-center gap-1 truncate text-xs text-pit-ink/80">
            {leading && isLive ? (
              <>
                <CheckIcon className="size-3.5 text-go" />
                <span>Highest bidder ·</span>
              </>
            ) : outbidMin !== null ? (
              <>
                <WarnIcon className="size-3.5 text-caution" />
                <span className="font-semibold text-caution">Outbid ·</span>
              </>
            ) : null}
            <Countdown full status={v.status} startsAt={v.startsAt} closesAt={v.closesAt} />
          </p>
          {ctl.bid.isError && !ctl.bid.isPending && (
            <p className="truncate text-xs font-semibold text-caution">
              {bidErrorMessage(ctl.bid.error)}
            </p>
          )}
        </div>
        {oneTap ? (
          <Button
            type="button"
            size="lg"
            className="shrink-0 tnum"
            disabled={!isLive || ctl.bid.isPending}
            onClick={() => ctl.place(outbidMin)}
          >
            {ctl.bid.isPending ? "Placing…" : `Bid ${formatINR(outbidMin)}`}
          </Button>
        ) : (
          <Button type="button" size="lg" onClick={jump} className="shrink-0">
            {v.status === "LIVE" ? "Bid" : "View"}
          </Button>
        )}
      </div>
    </div>
  );
}
