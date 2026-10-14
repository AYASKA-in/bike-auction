import { INSPECTION_SECTIONS, type PublicBike } from "@bike/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { BidHistory } from "@/components/live/bid-history";
import { Collapsible } from "@/components/live/collapsible";
import { LiveErrorBoundary, PageError } from "@/components/live/error-boundary";
import { LivePanel, outbidMinimum } from "@/components/live/live-panel";
import { outcomeCopy, type AnnounceSnap } from "@/components/live/logic";
import { MobileBar } from "@/components/live/mobile-bar";
import { useBidController } from "@/components/live/use-bid-controller";
import { useAnnouncement, useExtensionChip } from "@/components/live/use-live-signals";
import { useOutbidAlert } from "@/components/live/use-outbid-alert";
import { BikePlaceholder, GradeBadge, StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { EmptyBayArt } from "@/components/ui/empty-state";
import { CheckGlyph, ChevronGlyph, MinusGlyph, PinGlyph } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { WatchButton } from "@/components/watch-button";
import { ApiError } from "@/lib/api";
import { detailsQuery, liveViewQuery } from "@/lib/catalogue";
import { formatKm, ownersLabel } from "@/lib/format";
import { peekFeed } from "@/lib/live-feed";
import { useLiveAuction } from "@/lib/use-live-auction";
import { cn } from "@/lib/utils";

/** /auctions/:id — the live auction screen (BLUEPRINT §11.3), wrapped in an error boundary. */
export function AuctionDetailPage() {
  const { auctionId } = useParams({ from: "/auctions/$auctionId" });
  const qc = useQueryClient();
  return (
    <LiveErrorBoundary
      key={auctionId}
      onRetry={() => {
        void qc.resetQueries({ queryKey: ["details", auctionId] });
        void qc.resetQueries({ queryKey: ["view", auctionId] });
      }}
    >
      <AuctionDetail auctionId={auctionId} />
    </LiveErrorBoundary>
  );
}

function AuctionDetail({ auctionId }: { auctionId: string }) {
  const details = useQuery(detailsQuery(auctionId));
  // HTTP view: first paint + fallback while the socket is down. No polling while it is healthy.
  const seed = useQuery({
    ...liveViewQuery(auctionId),
    refetchInterval: () => (peekFeed(auctionId)?.getState().status === "live" ? false : 15_000),
  });
  const { state: live, feed } = useLiveAuction(auctionId, seed.data);
  const panelRef = useRef<HTMLElement>(null);
  const ctl = useBidController(auctionId, feed);
  const chip = useExtensionChip(live.view);
  const outbidMin = outbidMinimum(live, ctl);
  // A new key per outbid notice (the price that overtook us), so each one vibrates/flashes once.
  useOutbidAlert(
    outbidMin !== null ? `${auctionId}:${live.outbid?.currentPriceMinor ?? outbidMin}` : null,
  );
  const v = live.view;
  const snap: AnnounceSnap | null = v
    ? {
        auctionId,
        status: v.status,
        outcomeHeadline: outcomeCopy(v)?.headline ?? null,
        outbidMinMinor: outbidMin,
        extensionCount: v.extensionCount,
        closesAt: v.closesAt,
        acceptedBidId: ctl.bid.data?.bidId ?? null,
        acceptedAmountMinor: ctl.bid.data?.amountMinor ?? null,
      }
    : null;
  const announcement = useAnnouncement(snap);

  if (details.isError) {
    if (details.error instanceof ApiError && details.error.code === "NOT_FOUND") {
      return (
        <section className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-20 sm:px-6">
          <EmptyBayArt className="w-56" />
          <div>
            <h1 className="font-expanded text-3xl font-extrabold tracking-tight">
              This auction isn't available
            </h1>
            <p className="mt-3 text-steel">
              It may have been withdrawn, or the link is wrong. Other lots are still open.
            </p>
          </div>
          <Button asChild size="lg">
            <Link to="/auctions">Browse auctions</Link>
          </Button>
        </section>
      );
    }
    return (
      <PageError
        title="We couldn't load this auction"
        message="Check your connection and try again."
        error={details.error}
        onRetry={() => void details.refetch()}
      />
    );
  }
  const bike = details.data?.bike;
  return (
    <article className="mx-auto max-w-6xl px-4 pt-5 pb-32 sm:px-6 sm:pt-8 lg:pb-14">
      <nav aria-label="Breadcrumb" className="text-sm text-steel">
        <ol className="flex min-w-0 items-center gap-1">
          <li>
            <Link
              to="/auctions"
              className="inline-flex min-h-11 items-center font-semibold underline-offset-4 hover:text-asphalt hover:underline"
            >
              Auctions
            </Link>
          </li>
          {details.data && (
            <li className="flex min-w-0 items-center gap-1">
              <ChevronGlyph className="size-3.5" />
              <span aria-current="page" className="truncate">
                {details.data.title}
              </span>
            </li>
          )}
        </ol>
      </nav>
      {!details.data ? (
        <div className="mt-2 space-y-3">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-5 w-1/3" />
        </div>
      ) : (
        <header className="mt-1 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <h1 className="font-expanded text-[1.75rem] leading-tight font-extrabold tracking-tight text-balance sm:text-4xl">
              {details.data.title}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-steel">
              {v && <StatusBadge status={v.status} outcome={v.outcome} />}
              {bike && <GradeBadge grade={bike.inspection?.grade ?? null} />}
              {bike?.repossessed && (
                <span className="inline-flex items-center rounded-full border border-rule bg-paper px-2.5 py-1 text-xs leading-none font-semibold text-asphalt">
                  Bank repossessed
                </span>
              )}
              {bike && (
                <span className="inline-flex items-center gap-1">
                  <PinGlyph className="size-3.5" />
                  {bike.yard}, {bike.city}
                </span>
              )}
            </div>
          </div>
          {v && v.status !== "CANCELLED" && (
            <WatchButton auctionId={auctionId} variant="panel" className="sm:w-auto" />
          )}
        </header>
      )}

      {/* Mobile order: photos → live panel → bids → details (accordions). Desktop: sticky side panel. */}
      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-8">
        <div className="min-w-0 lg:col-start-1">
          {bike ? (
            <Gallery bike={bike} title={details.data!.title} />
          ) : (
            <Skeleton className="aspect-[4/3] w-full rounded-xl" />
          )}
        </div>
        <aside
          ref={panelRef}
          id="live-panel"
          aria-label="Live auction"
          className="scroll-mt-20 space-y-4 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start"
        >
          <LivePanel auctionId={auctionId} live={live} feed={feed} ctl={ctl} chip={chip} />
          <BidHistory live={live} feed={feed} />
        </aside>
        <div className="min-w-0 space-y-3 lg:col-start-1 lg:space-y-5">
          {bike ? (
            <>
              <Specs bike={bike} />
              <InspectionReport bike={bike} />
            </>
          ) : (
            <div className="space-y-3">
              <Skeleton className="h-48 w-full rounded-xl" />
              <Skeleton className="h-40 w-full rounded-xl" />
            </div>
          )}
          {details.data && (
            <Collapsible id="terms" title="Auction terms">
              <p className="mt-2 whitespace-pre-line text-steel">
                {details.data.terms || "Standard terms apply."}
              </p>
              {bike?.asIsWhereIs && !/as is,? where is/i.test(details.data.terms) && (
                <p className="mt-3 text-sm font-semibold">
                  Sold as is, where is. Inspect the bike at the yard before bidding.
                </p>
              )}
              {bike && <p className="mt-2 text-sm text-steel">{bike.description}</p>}
            </Collapsible>
          )}
        </div>
      </div>
      <MobileBar live={live} ctl={ctl} panelRef={panelRef} />
      {/* The page's only polite live region: outbid, accepted, extended, ended. Never the clock. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </article>
  );
}

function Gallery({ bike, title }: { bike: PublicBike; title: string }) {
  const [i, setI] = useState(0);
  const img = bike.images[i];
  if (bike.images.length === 0)
    return (
      <BikePlaceholder
        label={title}
        className="aspect-[16/10] w-full rounded-xl border border-rule lg:aspect-[16/11]"
      />
    );
  return (
    <div>
      <div className="aspect-[4/3] overflow-hidden rounded-xl bg-pit ring-1 ring-rule">
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
                  "block h-16 w-24 overflow-hidden rounded-md border-2 transition-opacity",
                  idx === i ? "border-hivis" : "border-transparent opacity-75 hover:opacity-100",
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
    <Collapsible id="specs" title="Details and documents">
      {bike.repossessed && (
        <p className="mt-2 rounded-md bg-concrete px-3 py-2 text-sm font-semibold">
          Bank or lender repossessed vehicle.
        </p>
      )}
      <dl className="mt-2 grid sm:grid-cols-2 sm:gap-x-6">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 border-b border-rule py-2.5 text-sm">
            <dt className="text-steel">{k}</dt>
            <dd className="text-right font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </Collapsible>
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
    <Collapsible
      id="insp"
      title="Inspection report"
      aside={<GradeBadge grade={r?.grade ?? null} />}
    >
      {!r ? (
        <p className="mt-2 text-steel">This bike hasn't been inspected yet.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-steel">
            Inspected by {r.inspectorName} on{" "}
            {new Date(r.inspectedAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}
          </p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {INSPECTION_SECTIONS.map((k) => {
              const s = r.sections[k];
              if (!s) return null;
              return (
                <li key={k} className="rounded-lg border border-rule bg-concrete/50 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-semibold">{SECTION_LABEL[k]}</span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 text-xs font-bold",
                        s.condition === "GOOD"
                          ? "text-ledger"
                          : s.condition === "FAIR"
                            ? "text-amber"
                            : "text-danger",
                      )}
                    >
                      {s.condition === "GOOD" ? (
                        <CheckGlyph className="size-3.5" />
                      ) : s.condition === "FAIR" ? (
                        <MinusGlyph className="size-3.5" />
                      ) : (
                        <WarnGlyph />
                      )}
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
    </Collapsible>
  );
}

function WarnGlyph() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="size-3.5 shrink-0">
      <path
        d="M10 2.5l8.5 15h-17z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M10 8v4.5M10 15v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
