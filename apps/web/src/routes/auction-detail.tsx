import {
  INSPECTION_SECTIONS,
  PlaceBidResult,
  type PublicAuctionView,
  type PublicBike,
  type PublicBid,
} from "@bike/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Countdown } from "@/components/countdown";
import { BikePlaceholder, GradeBadge, StatusBadge } from "@/components/status";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, apiPost } from "@/lib/api";
import { BidIntent, bidErrorMessage, checkBid, isUncertain } from "@/lib/bid-intent";
import { detailsQuery, liveViewQuery } from "@/lib/catalogue";
import { formatINR, formatIST, formatISTTime, formatKm, ownersLabel } from "@/lib/format";
import type { ConnStatus, LiveState } from "@/lib/live-auction";
import { peekFeed, type LiveFeed } from "@/lib/live-feed";
import { useMe } from "@/lib/session";
import { useLiveAuction } from "@/lib/use-live-auction";
import { cn } from "@/lib/utils";

export function AuctionDetailPage() {
  const { auctionId } = useParams({ from: "/auctions/$auctionId" });
  const details = useQuery(detailsQuery(auctionId));
  // HTTP view: first paint + fallback while the socket is down. No polling while it is healthy.
  const seed = useQuery({
    ...liveViewQuery(auctionId),
    refetchInterval: () => (peekFeed(auctionId)?.getState().status === "live" ? false : 15_000),
  });
  const { state: live, feed } = useLiveAuction(auctionId, seed.data);
  const panelRef = useRef<HTMLElement>(null);

  if (details.isError) {
    return (
      <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
        <h1 className="font-expanded text-3xl font-extrabold">This auction isn't available</h1>
        <p className="mt-3 text-steel">It may have been withdrawn, or the link is wrong.</p>
        <Link
          to="/auctions"
          className="mt-6 inline-block font-semibold underline underline-offset-4"
        >
          Browse auctions
        </Link>
      </section>
    );
  }
  const bike = details.data?.bike;
  return (
    <article className="mx-auto max-w-6xl px-4 pt-8 pb-28 sm:px-6 lg:pb-8">
      <nav aria-label="Breadcrumb" className="text-sm text-steel">
        <Link to="/auctions" className="underline underline-offset-4">
          Auctions
        </Link>
      </nav>
      {!details.data ? (
        <Skeleton className="mt-4 h-10 w-2/3" />
      ) : (
        <header className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="font-expanded text-3xl leading-tight font-extrabold tracking-tight sm:text-4xl">
            {details.data.title}
          </h1>
          {live.view && <StatusBadge status={live.view.status} outcome={live.view.outcome} />}
        </header>
      )}

      {/* Mobile order: photos → live panel → bids → details. Desktop: panel in a sticky side column. */}
      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_24rem]">
        <div className="min-w-0 lg:col-start-1">
          {bike ? (
            <Gallery bike={bike} title={details.data!.title} />
          ) : (
            <Skeleton className="aspect-[4/3] w-full" />
          )}
        </div>
        <aside
          ref={panelRef}
          id="live-panel"
          aria-label="Live auction"
          className="space-y-4 lg:sticky lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start"
        >
          <LivePanel auctionId={auctionId} live={live} feed={feed} />
          <BidHistory live={live} feed={feed} />
        </aside>
        <div className="min-w-0 space-y-8 lg:col-start-1">
          {bike && <Specs bike={bike} />}
          {bike && <InspectionReport bike={bike} />}
          {details.data && (
            <section
              aria-labelledby="terms-h"
              className="rounded-xl border border-rule bg-paper p-5"
            >
              <h2 id="terms-h" className="text-lg font-bold">
                Auction terms
              </h2>
              <p className="mt-2 whitespace-pre-line text-steel">
                {details.data.terms || "Standard terms apply."}
              </p>
              {bike?.asIsWhereIs && !/as is,? where is/i.test(details.data.terms) && (
                <p className="mt-3 text-sm font-semibold">
                  Sold as is, where is. Inspect the bike at the yard before bidding.
                </p>
              )}
              {bike && <p className="mt-2 text-sm text-steel">{bike.description}</p>}
            </section>
          )}
        </div>
      </div>
      <MobileBar live={live} panelRef={panelRef} />
    </article>
  );
}

function Gallery({ bike, title }: { bike: PublicBike; title: string }) {
  const [i, setI] = useState(0);
  const img = bike.images[i];
  if (bike.images.length === 0)
    return <BikePlaceholder label={title} className="aspect-[4/3] w-full rounded-xl" />;
  return (
    <div>
      <div className="aspect-[4/3] overflow-hidden rounded-xl bg-asphalt">
        <img src={img!.url} alt={img!.alt} className="size-full object-contain" />
      </div>
      {bike.images.length > 1 && (
        <ul className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Photos">
          {bike.images.map((im, idx) => (
            <li key={im.id} className="shrink-0">
              <button
                type="button"
                onClick={() => setI(idx)}
                aria-label={`Show photo ${idx + 1}: ${im.alt}`}
                aria-current={idx === i}
                className={cn(
                  "block h-16 w-24 overflow-hidden rounded-md border-2",
                  idx === i ? "border-hivis" : "border-transparent",
                )}
              >
                <img src={im.url} alt="" className="size-full object-cover" loading="lazy" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const RC: Record<PublicBike["rcStatus"], string> = {
  ORIGINAL: "Original RC",
  DUPLICATE: "Duplicate RC (issued by RTO)",
  PENDING_TRANSFER: "RC transfer pending",
};
const HYP: Record<PublicBike["hypothecation"], string> = {
  NONE: "No loan on record",
  ACTIVE: "Loan active, NOC from lender on full payment",
  NOC_ISSUED: "Loan closed, NOC issued",
};

function Specs({ bike }: { bike: PublicBike }) {
  const rows: [string, string][] = [
    ["Year", `${bike.manufactureYear} (registered ${bike.registrationYear})`],
    ["Kilometres", formatKm(bike.kmDriven)],
    ["Owners", ownersLabel(bike.ownerCount)],
    ["Engine", bike.fuel === "ELECTRIC" ? "Electric" : `${bike.engineCc} cc petrol`],
    ["Colour", bike.colour ?? "Not recorded"],
    ["Registration", `${bike.rtoCode} (${bike.registrationState})`],
    ["RC", RC[bike.rcStatus]],
    ["Loan / NOC", HYP[bike.hypothecation]],
    [
      "Insurance",
      bike.insuranceValidTill
        ? `Valid till ${new Date(bike.insuranceValidTill).toLocaleDateString("en-IN", { dateStyle: "medium" })}`
        : "Expired or not available",
    ],
    ["Location", `${bike.yard}, ${bike.city}`],
  ];
  return (
    <section aria-labelledby="specs-h">
      <h2 id="specs-h" className="text-lg font-bold">
        Details and documents
      </h2>
      {bike.repossessed && (
        <p className="mt-2 text-sm font-semibold">Bank or lender repossessed vehicle.</p>
      )}
      <dl className="mt-3 grid overflow-hidden rounded-xl border border-rule bg-paper sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div
            key={k}
            className="flex justify-between gap-4 border-b border-rule px-4 py-3 text-sm sm:odd:border-r"
          >
            <dt className="text-steel">{k}</dt>
            <dd className="text-right font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const SECTION_LABEL: Record<string, string> = {
  engine: "Engine",
  transmission: "Transmission",
  electricals: "Electricals",
  battery: "Battery",
  brakes: "Brakes",
  tyres: "Tyres",
  suspension: "Suspension",
  frame: "Frame",
  body: "Body and paint",
};

function InspectionReport({ bike }: { bike: PublicBike }) {
  const r = bike.inspection;
  return (
    <section aria-labelledby="insp-h" className="rounded-xl border border-rule bg-paper p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="insp-h" className="text-lg font-bold">
          Inspection report
        </h2>
        <GradeBadge grade={r?.grade ?? null} />
      </div>
      {!r ? (
        <p className="mt-2 text-steel">This bike hasn't been inspected yet.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-steel">
            Inspected by {r.inspectorName} on{" "}
            {new Date(r.inspectedAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}
          </p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-3">
            {INSPECTION_SECTIONS.map((k) => {
              const s = r.sections[k];
              if (!s) return null;
              return (
                <li key={k} className="rounded-md border border-rule px-3 py-2">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-semibold">{SECTION_LABEL[k]}</span>
                    <span
                      className={cn(
                        "text-xs font-bold",
                        s.condition === "GOOD"
                          ? "text-ledger"
                          : s.condition === "FAIR"
                            ? "text-amber"
                            : "text-danger",
                      )}
                    >
                      {s.condition === "GOOD" ? "Good" : s.condition === "FAIR" ? "Fair" : "Poor"}
                    </span>
                  </div>
                  {s.note && <p className="mt-1 text-xs text-steel">{s.note}</p>}
                </li>
              );
            })}
          </ul>
          {[
            ["Visible damage", r.visibleDamage],
            ["Mechanical issues", r.mechanicalIssues],
            ["Inspector notes", r.inspectorNotes],
          ].map(([k, v]) =>
            v ? (
              <p key={k} className="mt-3 text-sm">
                <span className="font-semibold">{k}: </span>
                {v}
              </p>
            ) : null,
          )}
        </>
      )}
    </section>
  );
}

const CONN_COPY: Record<ConnStatus, { label: string; note?: string; dot: string }> = {
  connecting: { label: "Connecting…", dot: "animate-pulse bg-paper/50" },
  live: { label: "Live updates connected", dot: "bg-ledger" },
  stale: {
    label: "Catching up…",
    note: "Some updates were missed. Refreshing from the server.",
    dot: "animate-pulse bg-amber",
  },
  reconnecting: {
    label: "Reconnecting…",
    note: "Connection lost. Figures below may be out of date.",
    dot: "animate-pulse bg-amber",
  },
  offline: {
    label: "Offline",
    note: "You're offline. Figures below may be out of date; bidding is paused.",
    dot: "bg-danger",
  },
  failed: {
    label: "Connection failed",
    note: "We can't reach the live feed. Figures may be out of date.",
    dot: "bg-danger",
  },
};

function ConnectionIndicator({ live, feed }: { live: LiveState; feed: LiveFeed | null }) {
  const c = CONN_COPY[live.status];
  return (
    <div className="text-xs">
      <p role="status" className="inline-flex items-center gap-2" data-conn={live.status}>
        <span aria-hidden="true" className={cn("size-2 rounded-full", c.dot)} />
        {c.label}
      </p>
      {c.note && live.view && (
        <p className="mt-1 text-paper/70">
          {c.note}
          {live.syncedAt !== null && <> Last updated {formatISTTime(live.syncedAt)}.</>}
          {(live.status === "failed" || live.status === "reconnecting") && feed && (
            <button
              type="button"
              onClick={() => feed.retryNow()}
              className="ml-2 font-semibold underline underline-offset-2"
            >
              Retry now
            </button>
          )}
        </p>
      )}
    </div>
  );
}

const RESULT: Record<NonNullable<PublicAuctionView["outcome"]>, string> = {
  SOLD: "Sold",
  RESERVE_NOT_MET: "Reserve not met. Not sold.",
  NO_BIDS: "Ended with no bids.",
};

function LivePanel({
  auctionId,
  live,
  feed,
}: {
  auctionId: string;
  live: LiveState;
  feed: LiveFeed | null;
}) {
  const view = live.view;
  if (!view) return <Skeleton className="h-80 w-full rounded-xl" />;
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
  const leading = view.viewer?.isLeading === true && view.status === "LIVE";
  return (
    <section className="rounded-xl bg-asphalt p-5 text-paper" aria-labelledby="price-h">
      <ConnectionIndicator live={live} feed={feed} />
      {leading && !stale && (
        <p
          role="status"
          data-testid="leading"
          className="mt-3 rounded-md bg-ledger px-3 py-2 font-bold"
        >
          You're leading
        </p>
      )}
      {leading && stale && (
        <p
          data-testid="leading-unconfirmed"
          className="mt-3 rounded-md bg-asphalt-2 px-3 py-2 text-sm"
        >
          You were leading at the last update. Reconnecting to confirm…
        </p>
      )}
      {live.outbid && !leading && view.status === "LIVE" && (
        <p
          role="alert"
          data-testid="outbid"
          className="mt-3 rounded-md bg-hivis px-3 py-2 font-bold text-white"
        >
          You've been outbid. New minimum{" "}
          {formatINR(view.minNextBidMinor ?? live.outbid.minNextBidMinor)}.
        </p>
      )}
      <p id="price-h" className="mt-3 text-sm font-semibold text-paper/80">
        {priceLabel}
        {stale && <span className="ml-2 text-xs font-normal text-amber">(may be outdated)</span>}
      </p>
      <p
        data-testid="price"
        className={cn("font-expanded text-4xl font-extrabold tnum", stale && "opacity-70")}
      >
        {formatINR(view.currentPriceMinor ?? view.startPriceMinor)}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-paper/60">Bids</dt>
          <dd data-testid="bid-count" className="font-semibold tnum">
            {view.bidCount}
          </dd>
        </div>
        <div>
          <dt className="text-paper/60">Reserve</dt>
          <dd className="font-semibold">
            {!view.hasReserve ? "No reserve" : view.reserveMet ? "Reserve met" : "Reserve not met"}
          </dd>
        </div>
        {view.status === "LIVE" && view.minNextBidMinor !== null && (
          <div>
            <dt className="text-paper/60">Minimum next bid</dt>
            <dd data-testid="min-next" className="font-semibold tnum">
              {formatINR(view.minNextBidMinor)}
            </dd>
          </div>
        )}
        {view.leadingBidder && view.status !== "CANCELLED" && (
          <div>
            <dt className="text-paper/60">{view.status === "ENDED" ? "Winner" : "Leading"}</dt>
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
          <dt className="text-paper/60">Starts</dt>
          <dd className="font-semibold">{formatIST(view.startsAt)}</dd>
        </div>
        <div>
          <dt className="text-paper/60">{view.status === "ENDED" ? "Closed" : "Closes"}</dt>
          <dd data-testid="closes" data-ms={view.closesAt} className="font-semibold">
            {formatIST(view.closesAt)}
          </dd>
        </div>
      </dl>
      <p
        data-testid="countdown"
        className="mt-4 rounded-md bg-asphalt-2 px-3 py-2 text-center font-expanded text-lg font-bold"
      >
        <Countdown full status={view.status} startsAt={view.startsAt} closesAt={view.closesAt} />
      </p>
      {view.extensionCount > 0 && view.status === "LIVE" && (
        <p className="mt-2 text-xs text-paper/70" data-testid="extended">
          Extended {view.extensionCount}× by late bids (anti-sniping).
        </p>
      )}
      {view.status === "LIVE" && (
        <BidForm auctionId={auctionId} view={view} feed={feed} paused={stale} />
      )}
      {view.status === "ENDED" && view.outcome && (
        <p data-testid="result" className="mt-4 rounded-md bg-asphalt-2 px-3 py-2 font-semibold">
          {view.outcome === "SOLD"
            ? view.viewer?.isWinner
              ? "You won this auction. Our team will contact you."
              : `Sold to ${view.leadingBidder ?? "the highest bidder"}.`
            : RESULT[view.outcome]}
        </p>
      )}
      {view.status === "CANCELLED" && (
        <p data-testid="result" className="mt-4 rounded-md bg-asphalt-2 px-3 py-2 font-semibold">
          This auction was cancelled. No sale will take place.
        </p>
      )}
    </section>
  );
}

/** Bid form. Success is shown only after the server's 201; a timeout never places a new bid. */
function BidForm({
  auctionId,
  view,
  feed,
  paused,
}: {
  auctionId: string;
  view: PublicAuctionView;
  feed: LiveFeed | null;
  paused: boolean;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const min = view.minNextBidMinor ?? view.startPriceMinor;
  const [rupees, setRupees] = useState(String(min / 100));
  const [confirming, setConfirming] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [intent] = useState(() => new BidIntent());
  const lastMin = useRef(min);
  useEffect(() => {
    if (min !== lastMin.current) {
      lastMin.current = min;
      setRupees(String(min / 100));
      setConfirming(null);
    }
  }, [min]);
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
  if (!me.data) {
    return (
      <div className="mt-4 space-y-2">
        {bid.error instanceof ApiError && bid.error.code === "AUTH_REQUIRED" && (
          <Alert>Your session has expired. Sign in again to bid.</Alert>
        )}
        <Link
          to="/login"
          search={{ redirect: `/auctions/${auctionId}` }}
          className="block rounded-md bg-hivis px-4 py-3 text-center font-semibold text-white"
        >
          Sign in to bid
        </Link>
      </div>
    );
  }
  if (me.data.role === "ADMIN")
    return <p className="mt-4 text-sm text-paper/70">Administrators can't bid.</p>;

  const send = (amountMinor: number) => {
    setConfirming(null);
    bid.mutate(amountMinor);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (bid.isPending) return;
    const c = checkBid(rupees, min);
    if (!c.ok) {
      setLocalError(c.message);
      return;
    }
    setLocalError(null);
    if (c.needsConfirm && confirming !== c.amountMinor) {
      setConfirming(c.amountMinor);
      return;
    }
    send(c.amountMinor);
  };
  const retryAmount = bid.isError && isUncertain(bid.error) ? intent.pendingRetryAmount : null;
  const leading = view.viewer?.isLeading === true;
  return (
    <form onSubmit={submit} className="mt-4 space-y-3" noValidate>
      <label className="block text-sm font-semibold" htmlFor="bid-amount">
        Your bid in ₹ (minimum {formatINR(min)})
      </label>
      <div className="flex gap-2">
        <input
          id="bid-amount"
          inputMode="numeric"
          autoComplete="off"
          value={rupees}
          aria-invalid={localError !== null}
          aria-describedby={localError ? "bid-error" : undefined}
          onChange={(e) => {
            setRupees(e.target.value.replace(/[^\d]/g, ""));
            setConfirming(null);
            setLocalError(null);
          }}
          className="h-14 w-full min-w-0 rounded-md bg-paper px-3 font-expanded text-xl font-bold text-asphalt tnum"
        />
        <button
          type="button"
          onClick={() => setRupees(String(min / 100))}
          className="shrink-0 rounded-md border border-paper/30 px-3 text-sm font-semibold"
        >
          Min
        </button>
      </div>
      {localError && (
        <p id="bid-error" className="text-sm font-semibold text-amber">
          {localError}
        </p>
      )}
      {confirming !== null ? (
        <div
          role="alertdialog"
          aria-label="Confirm large bid"
          className="space-y-2 rounded-md bg-asphalt-2 p-3"
        >
          <p className="text-sm">
            {formatINR(confirming)} is well above the minimum ({formatINR(min)}). Place this bid?
          </p>
          <div className="flex gap-2">
            <Button type="button" size="lg" className="flex-1" onClick={() => send(confirming)}>
              Yes, bid {formatINR(confirming)}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="ghost"
              className="flex-1 bg-paper text-asphalt"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="submit"
          size="lg"
          className="h-14 w-full text-lg"
          disabled={paused || bid.isPending || leading}
        >
          {bid.isPending
            ? "Placing bid…"
            : leading
              ? "You have the highest bid"
              : paused
                ? "Bidding paused while reconnecting"
                : `Place bid ${formatINR(Number(rupees || 0) * 100)}`}
        </Button>
      )}
      {bid.isError && (
        <Alert>
          {bidErrorMessage(bid.error)}
          {retryAmount !== null && (
            <button
              type="button"
              className="ml-2 font-semibold underline underline-offset-2"
              onClick={() => bid.mutate(retryAmount)}
            >
              Retry {formatINR(retryAmount)}
            </button>
          )}
        </Alert>
      )}
      {bid.isSuccess && !bid.isPending && (
        <p className="text-sm text-paper/80" role="status" data-testid="bid-confirmed">
          Bid of {formatINR(bid.data.amountMinor)} accepted.
        </p>
      )}
    </form>
  );
}

function BidHistory({ live, feed }: { live: LiveState; feed: LiveFeed | null }) {
  const [loading, setLoading] = useState(false);
  if (!live.view || live.view.bidCount === 0) return null;
  const more = live.olderCursor !== null && live.olderCursor !== undefined;
  return (
    <section aria-labelledby="bids-h" className="rounded-xl border border-rule bg-paper p-4">
      <h2 id="bids-h" className="text-base font-bold">
        Recent bids
      </h2>
      {live.bids.length === 0 ? (
        <p className="mt-2 text-sm text-steel">Loading bids…</p>
      ) : (
        <ol className="mt-2 divide-y divide-rule text-sm" data-testid="bid-history">
          {live.bids.map((b: PublicBid, i) => (
            <li
              key={b.seq}
              data-seq={b.seq}
              className={cn(
                "flex items-center justify-between gap-3 py-2",
                i === 0 && "font-semibold",
              )}
            >
              <span>
                {b.bidder}
                {b.isYou && (
                  <span className="ml-2 rounded bg-ledger/15 px-1.5 py-0.5 text-xs font-bold text-ledger">
                    You
                  </span>
                )}
              </span>
              <span className="text-right">
                <span className="tnum">{formatINR(b.amountMinor)}</span>
                <span className="block text-xs font-normal text-steel tnum">
                  {formatISTTime(b.at)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {more && (
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void feed?.loadOlder().finally(() => setLoading(false));
          }}
          className="mt-2 text-sm font-semibold underline underline-offset-4"
        >
          {loading ? "Loading…" : "Load older bids"}
        </button>
      )}
    </section>
  );
}

/** Mobile: price, countdown and a jump-to-bid button stay visible while reading the details. */
function MobileBar({
  live,
  panelRef,
}: {
  live: LiveState;
  panelRef: React.RefObject<HTMLElement | null>;
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
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [panelRef]);
  const v = live.view;
  if (!v || panelVisible) return null;
  const leading = v.viewer?.isLeading === true && v.status === "LIVE";
  return (
    <div
      data-testid="mobile-bar"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-asphalt-2 bg-asphalt px-4 py-3 text-paper lg:hidden"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-expanded text-xl font-extrabold tnum">
            {formatINR(v.currentPriceMinor ?? v.startPriceMinor)}
            {live.status !== "live" && (
              <span className="ml-2 text-xs font-normal text-amber">may be outdated</span>
            )}
          </p>
          <p className="truncate text-xs text-paper/80">
            {leading && live.status === "live"
              ? "You're leading · "
              : live.outbid && v.status === "LIVE"
                ? "Outbid · "
                : ""}
            <Countdown full status={v.status} startsAt={v.startsAt} closesAt={v.closesAt} />
          </p>
        </div>
        <Button type="button" size="lg" onClick={jump} className="shrink-0">
          {v.status === "LIVE" ? "Bid" : "View"}
        </Button>
      </div>
    </div>
  );
}
