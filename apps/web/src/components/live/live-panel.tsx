import type { PublicAuctionView } from "@bike/contracts";
import { Countdown } from "@/components/countdown";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatEndsAt, formatExtension, formatINR, formatIST } from "@/lib/format";
import type { LiveState } from "@/lib/live-auction";
import type { LiveFeed } from "@/lib/live-feed";
import { useServerNow } from "@/lib/server-time";
import { cn } from "@/lib/utils";
import { BidForm } from "./bid-form";
import { ProxyBidForm } from "./proxy-bid-form";
import { ConnectionIndicator } from "./connection-indicator";
import { CheckIcon, ClockIcon, WarnIcon } from "./icons";
import { SOFT_CLOSE_NOTE, softCloseActive } from "./logic";
import { OutcomeCard } from "./outcome-card";
import { FlashOnChange } from "./panel-bits";
import type { BidController } from "./use-bid-controller";
import type { ExtensionChip } from "./use-live-signals";

/** The minimum to show in the outbid banner, or null when the viewer isn't (still) outbid. */
export function outbidMinimum(live: LiveState, ctl: BidController): number | null {
  const v = live.view;
  if (!v || !live.outbid || v.status !== "LIVE" || v.viewer?.isLeading === true) return null;
  return ctl.minFor(v);
}

export function LivePanel({
  auctionId,
  live,
  feed,
  ctl,
  chip,
}: {
  auctionId: string;
  live: LiveState;
  feed: LiveFeed | null;
  ctl: BidController;
  chip: ExtensionChip | null;
}) {
  const view = live.view;
  if (!view)
    return (
      <div
        className="space-y-3 rounded-xl bg-pit p-5 shadow-pop ring-1 ring-pit-line"
        aria-busy="true"
      >
        <span className="sr-only">Loading live auction…</span>
        <Skeleton className="h-6 w-20 rounded-full bg-pit-2" />
        <Skeleton className="h-4 w-24 bg-pit-2" />
        <Skeleton className="h-10 w-48 bg-pit-2" />
        <Skeleton className="h-16 w-full bg-pit-2" />
        <Skeleton className="h-24 w-full bg-pit-2" />
        <Skeleton className="h-14 w-full bg-pit-2" />
        <Skeleton className="h-14 w-full bg-pit-2" />
      </div>
    );
  const stale = live.status !== "live";
  const priceLabel =
    view.status === "ENDED"
      ? view.outcome === "SOLD"
        ? "Sold for"
        : view.currentPriceMinor === null
          ? "Starting bid"
          : "Highest bid"
      : view.currentPriceMinor === null
        ? "Starting bid"
        : "Current bid";
  const price = view.currentPriceMinor ?? view.startPriceMinor;
  const leading = view.viewer?.isLeading === true && view.status === "LIVE";
  const myMax = view.viewer?.myMaxMinor ?? null;
  const outbidMin = outbidMinimum(live, ctl);
  return (
    <section
      className="rounded-xl bg-pit p-5 text-pit-ink shadow-pop ring-1 ring-pit-line sm:p-6"
      aria-labelledby="price-h"
    >
      <ConnectionIndicator live={live} feed={feed} />
      {leading && !stale && (
        <p
          data-testid="leading"
          className="mt-4 flex items-center gap-2 rounded-md bg-win px-3 py-2.5 font-bold text-white"
        >
          <CheckIcon />
          You're the highest bidder
        </p>
      )}
      {leading && stale && (
        <p
          data-testid="leading-unconfirmed"
          className="mt-4 rounded-md bg-pit-2 px-3 py-2.5 text-sm"
        >
          You were leading at the last update. Reconnecting to confirm…
        </p>
      )}
      {outbidMin !== null && (
        <div data-testid="outbid" className="mt-4 rounded-md bg-caution px-3 py-3 text-on-hivis">
          <p className="flex items-start gap-2 font-bold">
            <WarnIcon className="mt-px" />
            <span>
              You've been outbid. Minimum now <span className="tnum">{formatINR(outbidMin)}</span>
            </span>
          </p>
          {ctl.canBid && (
            <Button
              type="button"
              size="lg"
              className="mt-2.5 w-full bg-on-hivis text-pit-ink hover:bg-pit-2"
              disabled={stale || ctl.bid.isPending}
              onClick={() => ctl.place(outbidMin)}
            >
              {ctl.bid.isPending ? "Placing bid…" : `Bid ${formatINR(outbidMin)} now`}
            </Button>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div>
          <p id="price-h" className="text-sm font-semibold text-pit-ink/80">
            {priceLabel}
            {stale && (
              <span className="ml-2 text-xs font-normal text-caution">(may be outdated)</span>
            )}
          </p>
          <p
            data-testid="price"
            className={cn(
              "mt-0.5 font-expanded text-[2.5rem] leading-none font-extrabold tracking-tight tnum",
              stale && "opacity-70",
            )}
          >
            <FlashOnChange value={price} className="-mx-1 px-1">
              {formatINR(price)}
            </FlashOnChange>
          </p>
        </div>
        <ReserveBadge view={view} />
      </div>

      <div className="mt-5 rounded-lg bg-pit-2 px-3 py-3">
        {/* The ticking timer is never in a live region; extensions are announced separately. */}
        <p data-testid="countdown" className="text-center font-expanded text-lg font-bold">
          <Countdown full status={view.status} startsAt={view.startsAt} closesAt={view.closesAt} />
        </p>
        {(view.status === "LIVE" || view.status === "SCHEDULED") && (
          <DeadlineNotes view={view} chip={view.status === "LIVE" ? chip : null} />
        )}
      </div>
      {view.extensionCount > 0 && view.status === "LIVE" && (
        <p className="mt-2 text-xs text-pit-ink/75" data-testid="extended">
          Extended {view.extensionCount}× by late bids (anti-sniping).
        </p>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-pit-ink/12 py-4 text-sm">
        <div>
          <dt className="text-pit-ink/70">Bids</dt>
          <dd data-testid="bid-count" className="font-semibold tnum">
            {view.bidCount}
          </dd>
        </div>
        {view.status === "LIVE" && view.minNextBidMinor !== null && (
          <div>
            <dt className="text-pit-ink/70">Minimum next bid</dt>
            <dd data-testid="min-next" className="font-semibold tnum">
              {formatINR(view.minNextBidMinor)}
            </dd>
          </div>
        )}
        {view.leadingBidder && view.status !== "CANCELLED" && (
          <div>
            <dt className="text-pit-ink/70">{view.status === "ENDED" ? "Winner" : "Leading"}</dt>
            <dd data-testid="leader" className="font-semibold">
              {view.status === "ENDED" && view.outcome !== "SOLD"
                ? "No winner"
                : view.viewer?.isLeading || view.viewer?.isWinner
                  ? `You (${view.leadingBidder})`
                  : view.leadingBidder}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-pit-ink/70">Starts</dt>
          <dd className="font-semibold">{formatIST(view.startsAt)}</dd>
        </div>
        <div>
          <dt className="text-pit-ink/70">{view.status === "ENDED" ? "Closed" : "Closes"}</dt>
          <dd data-testid="closes" data-ms={view.closesAt} className="font-semibold">
            {formatIST(view.closesAt)}
          </dd>
        </div>
      </dl>

      {view.status === "LIVE" && (
        <BidForm auctionId={auctionId} view={view} ctl={ctl} paused={stale} />
      )}
      {view.status === "LIVE" && view.viewer && (
        <details
          className="mt-5 rounded-lg border border-pit-ink/20 px-3 py-1.5"
          open={myMax !== null}
        >
          <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold marker:text-pit-ink/60">
            Auto-bid: set a maximum
            {myMax !== null && (
              <span className="ml-2 font-normal text-pit-ink/80">(yours: {formatINR(myMax)})</span>
            )}
          </summary>
          <ProxyBidForm auctionId={auctionId} view={view} />
        </details>
      )}
      {(view.status === "ENDED" || view.status === "CANCELLED") && <OutcomeCard view={view} />}
    </section>
  );
}

function ReserveBadge({ view }: { view: PublicAuctionView }) {
  if (!view.hasReserve)
    return (
      <span className="rounded-full border border-pit-ink/30 px-2.5 py-1 text-xs font-semibold">
        No reserve
      </span>
    );
  return view.reserveMet ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-win px-2.5 py-1 text-xs font-bold text-white">
      Reserve met <CheckIcon className="size-3.5" />
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-caution/70 px-2.5 py-1 text-xs font-semibold text-caution">
      <WarnIcon className="size-3.5" />
      Reserve not met
    </span>
  );
}

/** Ticking leaf (shared 1 s server ticker): absolute end time, soft-close note, extension chip. */
function DeadlineNotes({ view, chip }: { view: PublicAuctionView; chip: ExtensionChip | null }) {
  const now = useServerNow();
  const soft = softCloseActive(view, now);
  return (
    <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-xs">
      <span className="inline-flex items-center gap-1 text-pit-ink/80">
        <ClockIcon className="size-3.5" />
        Ends {formatEndsAt(view.closesAt, now)}
      </span>
      {chip && (
        <span
          key={chip.key}
          data-testid="extended-chip"
          className="live-pop rounded-full bg-caution px-2 py-0.5 font-bold text-on-hivis tnum"
        >
          {formatExtension(chip.ms)} extended
        </span>
      )}
      {soft && (
        <span data-testid="soft-close" className="w-full text-center font-semibold text-caution">
          {SOFT_CLOSE_NOTE}
        </span>
      )}
    </div>
  );
}
