import { INSPECTION_SECTIONS, type PublicAuctionView, type PublicBike } from "@bike/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Countdown } from "@/components/countdown";
import { BikePlaceholder, GradeBadge, StatusBadge } from "@/components/status";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, apiPost } from "@/lib/api";
import { detailsQuery, liveViewQuery } from "@/lib/catalogue";
import { formatINR, formatIST, formatKm, ownersLabel } from "@/lib/format";
import { useMe } from "@/lib/session";
import { useLiveAuction } from "@/lib/use-live-auction";
import { cn } from "@/lib/utils";

export function AuctionDetailPage() {
  const { auctionId } = useParams({ from: "/auctions/$auctionId" });
  const details = useQuery(detailsQuery(auctionId));
  const seed = useQuery(liveViewQuery(auctionId));
  const live = useLiveAuction(auctionId, seed.data);

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
    <article className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
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

      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_24rem]">
        <div className="min-w-0 space-y-8">
          {bike ? (
            <Gallery bike={bike} title={details.data!.title} />
          ) : (
            <Skeleton className="aspect-[4/3] w-full" />
          )}
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
              {bike?.asIsWhereIs && (
                <p className="mt-3 text-sm font-semibold">
                  Sold as is, where is. Inspect the bike at the yard before bidding.
                </p>
              )}
              {bike && <p className="mt-2 text-sm text-steel">{bike.description}</p>}
            </section>
          )}
        </div>
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <LivePanel
            auctionId={auctionId}
            view={live.view}
            connection={live.status}
            outbid={live.outbid}
          />
        </aside>
      </div>
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

function LivePanel({
  auctionId,
  view,
  connection,
  outbid,
}: {
  auctionId: string;
  view: PublicAuctionView | null;
  connection: string;
  outbid: { minNextBidMinor: number } | null;
}) {
  if (!view) return <Skeleton className="h-80 w-full rounded-xl" />;
  const priceLabel =
    view.status === "ENDED"
      ? view.outcome === "SOLD"
        ? "Sold for"
        : "Final bid"
      : view.currentPriceMinor === null
        ? "Starting bid"
        : "Current bid";
  return (
    <div className="rounded-xl bg-asphalt p-5 text-paper">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-semibold text-paper/80">{priceLabel}</span>
        <span role="status" className="inline-flex items-center gap-2 text-xs">
          <span
            aria-hidden="true"
            className={cn(
              "size-2 rounded-full",
              connection === "live"
                ? "bg-hivis"
                : connection === "stale"
                  ? "bg-danger"
                  : "animate-pulse bg-paper/50",
            )}
          />
          {connection === "live"
            ? "Live updates on"
            : connection === "stale"
              ? "Reconnecting…"
              : "Connecting…"}
        </span>
      </div>
      <p className="mt-1 font-expanded text-4xl font-extrabold tnum">
        {formatINR(view.currentPriceMinor ?? view.startPriceMinor)}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-paper/60">Bids</dt>
          <dd className="font-semibold tnum">{view.bidCount}</dd>
        </div>
        <div>
          <dt className="text-paper/60">Reserve</dt>
          <dd className="font-semibold">
            {!view.hasReserve ? "No reserve" : view.reserveMet ? "Reserve met" : "Reserve not met"}
          </dd>
        </div>
        <div>
          <dt className="text-paper/60">Starts</dt>
          <dd className="font-semibold">{formatIST(view.startsAt)}</dd>
        </div>
        <div>
          <dt className="text-paper/60">Closes</dt>
          <dd className="font-semibold">{formatIST(view.closesAt)}</dd>
        </div>
        {view.leadingBidder && (
          <div className="col-span-2">
            <dt className="text-paper/60">Leading</dt>
            <dd className="font-semibold">{view.viewer?.isLeading ? "You" : view.leadingBidder}</dd>
          </div>
        )}
      </dl>
      <p className="mt-4 rounded-md bg-asphalt-2 px-3 py-2 text-sm">
        <Countdown status={view.status} startsAt={view.startsAt} closesAt={view.closesAt} />
      </p>
      {view.extensionCount > 0 && view.status === "LIVE" && (
        <p className="mt-2 text-xs text-paper/70">
          Extended {view.extensionCount}× by late bids (anti-sniping).
        </p>
      )}
      {view.status === "LIVE" && (
        <BidForm
          auctionId={auctionId}
          view={view}
          disabled={connection !== "live"}
          outbidMin={outbid?.minNextBidMinor ?? null}
        />
      )}
      {view.status === "ENDED" && view.viewer?.isWinner && (
        <p className="mt-4 rounded-md bg-ledger px-3 py-2 font-semibold">
          You won this auction. Our team will contact you.
        </p>
      )}
    </div>
  );
}

/** Minimal working bid form (the full bidding experience is Day 7). Server is the authority. */
function BidForm({
  auctionId,
  view,
  disabled,
  outbidMin,
}: {
  auctionId: string;
  view: PublicAuctionView;
  disabled: boolean;
  outbidMin: number | null;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const min = view.minNextBidMinor ?? view.startPriceMinor;
  const [rupees, setRupees] = useState(String(min / 100));
  const keyRef = useRef<string | null>(null);
  const lastMin = useRef(min);
  useEffect(() => {
    if (min !== lastMin.current) {
      lastMin.current = min;
      setRupees(String(min / 100));
    }
  }, [min]);
  const bid = useMutation({
    // Reusing the key for a retry of the SAME amount makes network retries safe.
    mutationFn: (amountMinor: number) =>
      apiPost(`/auctions/${auctionId}/bids`, { amountMinor }, (x) => x, {
        "idempotency-key": (keyRef.current ??= crypto.randomUUID()),
      }),
    onSuccess: () => {
      keyRef.current = null;
      void qc.invalidateQueries({ queryKey: ["view", auctionId] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code !== "NETWORK") keyRef.current = null; // definitive answer: next try is a new intent
    },
  });
  if (!me.data) {
    return (
      <Link
        to="/login"
        search={{ redirect: `/auctions/${auctionId}` }}
        className="mt-4 block rounded-md bg-hivis px-4 py-3 text-center font-semibold text-white"
      >
        Sign in to bid
      </Link>
    );
  }
  if (me.data.role === "ADMIN")
    return <p className="mt-4 text-sm text-paper/70">Administrators can't bid.</p>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const amount = Math.round(Number(rupees) * 100);
    if (Number.isFinite(amount) && amount > 0) bid.mutate(amount);
  };
  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      {view.viewer?.isLeading && (
        <p className="rounded-md bg-ledger px-3 py-2 text-sm font-semibold">
          You have the highest bid.
        </p>
      )}
      {outbidMin !== null && !view.viewer?.isLeading && (
        <p className="rounded-md bg-amber px-3 py-2 text-sm font-semibold">You've been outbid.</p>
      )}
      <label className="block text-sm font-semibold" htmlFor="bid-amount">
        Your bid (₹), minimum {formatINR(min)}
      </label>
      <input
        id="bid-amount"
        inputMode="numeric"
        value={rupees}
        onChange={(e) => setRupees(e.target.value.replace(/[^\d]/g, ""))}
        className="h-12 w-full rounded-md bg-paper px-3 text-lg font-bold text-asphalt tnum"
      />
      <Button
        type="submit"
        size="lg"
        className="w-full"
        disabled={disabled || bid.isPending || view.viewer?.isLeading === true}
      >
        {bid.isPending
          ? "Placing bid…"
          : `Place bid ${formatINR(Math.round(Number(rupees || 0) * 100))}`}
      </Button>
      {bid.isError && <Alert>{bidError(bid.error)}</Alert>}
      {bid.isSuccess && (
        <p className="text-sm text-paper/80" role="status">
          Bid placed.
        </p>
      )}
    </form>
  );
}

function bidError(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong.";
  const map: Partial<Record<string, string>> = {
    BID_TOO_LOW: "Someone bid first. The minimum has gone up.",
    ALREADY_LEADING: "You already have the highest bid.",
    BID_UNREASONABLE: "That's far above the current price. Check the amount.",
    AUCTION_ENDED: "This auction has ended.",
    RATE_LIMITED: "You're bidding very fast. Wait a moment.",
    NETWORK: "Connection problem. Press the button again; your bid won't be placed twice.",
  };
  return map[e.code] ?? e.detail ?? "Your bid wasn't placed.";
}
