import { formatINR, minNextBid, rupees } from "@bike/domain";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AuctionCard, CardSkeleton } from "@/components/auction-card";
import { AuctionClock } from "@/components/auction-clock";
import { Countdown } from "@/components/countdown";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ChevronGlyph, DocGlyph, InspectGlyph, TimerGlyph } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { catalogueQuery, type CatalogueFilters } from "@/lib/catalogue";

const example = { start: rupees(75_000), current: rupees(81_500) };

const steps = [
  {
    title: "Check the lot",
    body: "Each bike lists its RTO code, owner count, RC and loan status, and an inspection grade from our yard team. Repossessed bikes are sold as-is, where-is.",
  },
  {
    title: "Bid at or above the minimum",
    body: `The minimum next bid is the current price plus a step that grows with the price. At ${formatINR(example.current)} it is ${formatINR(minNextBid({ startPriceMinor: example.start, currentPriceMinor: example.current }))}.`,
  },
  {
    title: "Late bids extend the clock",
    body: "A bid in the last two minutes adds two minutes, so nobody wins by sniping. Extensions are capped, so every auction ends.",
  },
  {
    title: "Highest bid at close wins",
    body: "If the hidden reserve price is met, the top bidder wins and our team contacts them. If not, the lot is not sold.",
  },
];

const trust: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <InspectGlyph className="size-5" />,
    title: "Inspected at the yard",
    body: "Engine, brakes, tyres and frame graded A to D, with the inspector's notes.",
  },
  {
    icon: <DocGlyph className="size-5" />,
    title: "Paperwork up front",
    body: "RTO code, RC status, owners and any loan or NOC, before you bid.",
  },
  {
    icon: <TimerGlyph className="size-5" />,
    title: "Timed by the server",
    body: "The auction server decides if a bid was in time, never your phone's clock.",
  },
];

const LIVE_FILTERS: CatalogueFilters = { status: "LIVE", sort: "ending_soon" };

export function HomePage() {
  return (
    <>
      <section className="border-b border-rule bg-paper">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-12 pb-14 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:items-start lg:gap-14 lg:pt-16 lg:pb-20">
          <div>
            <h1 className="max-w-[15ch] font-expanded text-[2.5rem] leading-[1.02] font-extrabold tracking-tight text-balance sm:text-5xl lg:text-[3.6rem]">
              Live auctions for used and repossessed two-wheelers
            </h1>
            <p className="mt-6 max-w-[54ch] text-lg leading-relaxed text-steel">
              Inspected bikes and scooters from bank and lender recoveries, sold to the highest
              bidder. See the price, the minimum next bid and whether you're winning as it happens.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/auctions" search={{ status: "LIVE" }}>
                  Browse live auctions
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/" hash="how-it-works">
                  How bidding works
                </Link>
              </Button>
            </div>
            <ul className="mt-10 grid gap-5 border-t border-rule pt-6 sm:grid-cols-3 sm:gap-6">
              {trust.map((t) => (
                <li key={t.title}>
                  <span className="flex size-9 items-center justify-center rounded-lg bg-concrete text-asphalt">
                    {t.icon}
                  </span>
                  <p className="mt-3 font-bold">{t.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-steel">{t.body}</p>
                </li>
              ))}
            </ul>
          </div>
          <AuctionClock>
            <LiveBoard />
          </AuctionClock>
        </div>
      </section>

      <div id="auctions" className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <Shelf
          title="Ending soon"
          filters={LIVE_FILTERS}
          empty="No auctions are live right now. Check the upcoming ones below."
        />
        <Shelf
          title="Starting soon"
          filters={{ status: "UPCOMING", sort: "starting_soon" }}
          empty="Nothing scheduled yet. New lots are added daily."
        />
        <Shelf
          title="Recently closed"
          filters={{ status: "ENDED", sort: "recently_ended" }}
          empty="No auctions have closed yet."
        />
        <div className="mt-12 flex flex-col items-start gap-4 rounded-xl border border-rule bg-paper p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-bold">Looking for something specific?</p>
            <p className="mt-1 text-sm text-steel">
              Filter by make, city, engine size, year and price.
            </p>
          </div>
          <Button asChild variant="secondary">
            <Link to="/auctions">Browse all auctions with filters</Link>
          </Button>
        </div>
      </div>

      <section
        id="how-it-works"
        aria-labelledby="how-heading"
        className="scroll-mt-20 border-t border-rule bg-paper"
      >
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:py-16">
          <h2 id="how-heading" className="font-expanded text-2xl font-extrabold tracking-tight">
            How bidding works
          </h2>
          <ol className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((s, i) => (
              <li key={s.title} className="border-t-4 border-asphalt pt-4">
                <span
                  className="font-expanded text-3xl font-extrabold text-hivis-ink tnum"
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <h3 className="mt-2 text-lg font-bold">{s.title}</h3>
                <p className="mt-2 leading-relaxed text-steel">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );
}

/** The three live lots closing first, as ticker rows on the clock board (shares the shelf's query). */
function LiveBoard() {
  const q = useInfiniteQuery(catalogueQuery(LIVE_FILTERS, 3));
  const items = q.data?.pages[0]?.items ?? [];
  return (
    <div className="border-t border-pit-ink/10 px-5 pt-4 pb-3 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-pit-ink/80">Closing next</h2>
        <Link
          to="/auctions"
          search={{ status: "LIVE" }}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-pit-ink underline-offset-4 hover:underline"
        >
          All live auctions
          <ChevronGlyph className="size-3.5" />
        </Link>
      </div>
      {q.isPending ? (
        <ul aria-hidden="true" className="divide-y divide-pit-ink/10">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex justify-between gap-4 py-3">
              <Skeleton className="h-10 w-1/2 bg-pit-2" />
              <Skeleton className="h-10 w-1/4 bg-pit-2" />
            </li>
          ))}
        </ul>
      ) : items.length === 0 ? (
        <p className="py-4 text-sm text-pit-ink/75">
          {q.isError ? "Couldn't load live auctions." : "No auctions are live right now."}
        </p>
      ) : (
        <ul className="divide-y divide-pit-ink/10">
          {items.map((a) => (
            <li key={a.auctionId}>
              <Link
                to="/auctions/$auctionId"
                params={{ auctionId: a.auctionId }}
                className="group -mx-2 flex items-center justify-between gap-4 rounded-md px-2 py-3 hover:bg-pit-2"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold group-hover:underline group-hover:underline-offset-4">
                    {a.make} {a.model}
                  </span>
                  <span className="block truncate text-xs text-pit-ink/70 tnum">
                    {a.city}, {a.bidCount} {a.bidCount === 1 ? "bid" : "bids"}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-expanded text-lg leading-tight font-extrabold tnum">
                    {formatINR(a.currentPriceMinor ?? a.startPriceMinor)}
                  </span>
                  <span className="block text-xs text-pit-ink/75">
                    <Countdown status={a.status} startsAt={a.startsAt} closesAt={a.closesAt} />
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Shelf({
  title,
  filters,
  empty,
}: {
  title: string;
  filters: CatalogueFilters;
  empty: string;
}) {
  const q = useInfiniteQuery(catalogueQuery(filters, 3));
  const items = q.data?.pages[0]?.items ?? [];
  const headingId = `shelf-${filters.status ?? "all"}`;
  return (
    <section aria-labelledby={headingId} className="mt-14 first:mt-0">
      <div className="flex items-end justify-between gap-4 border-b border-rule pb-3">
        <h2 id={headingId} className="font-expanded text-2xl font-extrabold tracking-tight">
          {title}
        </h2>
        <Link
          to="/auctions"
          search={{ status: filters.status, sort: filters.sort }}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold underline-offset-4 hover:underline"
        >
          See all<span className="sr-only"> {title.toLowerCase()}</span>
          <ChevronGlyph className="size-3.5" />
        </Link>
      </div>
      <div className="mt-5">
        {q.isPending ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            className="py-8 sm:py-8"
            title={q.isError ? "Couldn't load auctions." : empty}
          />
        ) : (
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((a) => (
              <li key={a.auctionId}>
                <AuctionCard a={a} stale={q.isRefetchError} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
