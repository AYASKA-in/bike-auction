import { formatINR, minNextBid, rupees } from "@bike/domain";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AuctionCard, CardSkeleton } from "@/components/auction-card";
import { AuctionClock } from "@/components/auction-clock";
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

export function HomePage() {
  return (
    <>
      <section className="border-b border-rule bg-paper">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:py-20">
          <div>
            <h1 className="max-w-[16ch] font-expanded text-4xl leading-[1.05] font-extrabold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              Live auctions for used and repossessed two-wheelers
            </h1>
            <p className="mt-6 max-w-[56ch] text-lg leading-relaxed text-steel">
              Inspected bikes from bank and lender recoveries, sold to the highest bidder. You see
              the price, the minimum next bid and whether you are winning as it happens. Every bid
              is timed by the auction server, not your phone.
            </p>
          </div>
          <AuctionClock />
        </div>
      </section>

      <div id="auctions" className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <Shelf
          title="Live now"
          filters={{ status: "LIVE" }}
          empty="No auctions are live right now. Check the upcoming ones below."
        />
        <Shelf
          title="Starting soon"
          filters={{ status: "UPCOMING" }}
          empty="Nothing scheduled yet. New lots are added daily."
        />
        <p className="mt-10">
          <Link to="/auctions" className="font-semibold underline underline-offset-4">
            Browse all auctions with filters
          </Link>
        </p>
      </div>

      <section
        id="how-it-works"
        aria-labelledby="how-heading"
        className="border-t border-rule bg-paper"
      >
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 id="how-heading" className="font-expanded text-2xl font-bold tracking-tight">
            How bidding works
          </h2>
          <ol className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((s, i) => (
              <li key={s.title} className="border-t-4 border-asphalt pt-4">
                <span
                  className="font-expanded text-3xl font-extrabold text-hivis tnum"
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
  return (
    <section aria-label={title} className="mt-10 first:mt-0">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-expanded text-2xl font-bold tracking-tight">{title}</h2>
        <Link
          to="/auctions"
          search={{ status: filters.status }}
          className="text-sm font-semibold underline underline-offset-4"
        >
          See all
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
          <p className="rounded-xl border border-dashed border-steel/40 bg-paper px-6 py-8 text-center text-steel">
            {q.isError ? "Couldn't load auctions." : empty}
          </p>
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
