import type { AuctionCard as Card } from "@bike/contracts";
import { Link } from "@tanstack/react-router";
import { formatINR, formatKm, ownersLabel } from "@/lib/format";
import { Countdown } from "./countdown";
import { BikePlaceholder, GradeBadge, StatusBadge } from "./status";

export function AuctionCard({ a }: { a: Card }) {
  const price = a.currentPriceMinor ?? a.startPriceMinor;
  const priceLabel =
    a.status === "ENDED"
      ? a.outcome === "SOLD"
        ? "Sold for"
        : "Final bid"
      : a.currentPriceMinor === null
        ? "Starting bid"
        : "Current bid";
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-xl border border-rule bg-paper transition-shadow hover:shadow-[0_8px_24px_-12px_#1d212540]">
      <div className="relative aspect-[4/3] overflow-hidden bg-concrete">
        {a.coverUrl ? (
          <img
            src={a.coverUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <BikePlaceholder label={a.title} className="size-full" />
        )}
        <div className="absolute left-3 top-3 flex gap-2">
          <StatusBadge status={a.status} outcome={a.outcome} />
          {a.repossessed && (
            <span className="rounded-full bg-paper/95 px-2.5 py-1 text-xs font-semibold">
              Bank repossessed
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg leading-snug font-bold">
            <Link
              to="/auctions/$auctionId"
              params={{ auctionId: a.auctionId }}
              className="after:absolute after:inset-0 focus-visible:outline-none"
            >
              {a.make} {a.model}
              {a.variant && <span className="font-medium text-steel"> {a.variant}</span>}
            </Link>
          </h3>
          <GradeBadge grade={a.inspectionGrade} />
        </div>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-steel">
          <li>{a.manufactureYear}</li>
          <li>{formatKm(a.kmDriven)}</li>
          <li>{ownersLabel(a.ownerCount)}</li>
          {a.engineCc && <li>{a.engineCc} cc</li>}
          <li>{a.city}</li>
        </ul>
        <div className="mt-auto flex items-end justify-between gap-3 border-t border-rule pt-3">
          <div>
            <p className="text-xs font-semibold text-steel">{priceLabel}</p>
            <p className="font-expanded text-2xl font-extrabold tnum">{formatINR(price)}</p>
          </div>
          <div className="text-right text-sm">
            <p className="text-steel tnum">
              {a.bidCount} {a.bidCount === 1 ? "bid" : "bids"}
            </p>
            <p>
              <Countdown status={a.status} startsAt={a.startsAt} closesAt={a.closesAt} />
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}

export function CardSkeleton() {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-xl border border-rule bg-paper">
      <div className="aspect-[4/3] animate-pulse bg-rule" />
      <div className="space-y-3 p-4">
        <div className="h-5 w-2/3 animate-pulse rounded bg-rule" />
        <div className="h-4 w-full animate-pulse rounded bg-rule" />
        <div className="h-8 w-1/2 animate-pulse rounded bg-rule" />
      </div>
    </div>
  );
}
