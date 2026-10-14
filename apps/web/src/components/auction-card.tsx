import type { AuctionCard as Card } from "@bike/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback } from "react";
import { refreshCatalogueSoon } from "@/lib/catalogue";
import { formatINR, formatKm, ownersLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Countdown } from "./countdown";
import { BikePlaceholder, GradeBadge, StatusBadge } from "./status";
import { ClockGlyph, PinGlyph } from "./ui/icons";
import { Skeleton } from "./ui/skeleton";
import { WatchButton } from "./watch-button";

/**
 * Catalogue card. Hierarchy: price first, then what the bike is, then when it ends. The title
 * link stretches over the whole card; the watch toggle sits above that overlay.
 */
export function AuctionCard({ a, stale = false }: { a: Card; stale?: boolean }) {
  const qc = useQueryClient();
  const onDue = useCallback(() => refreshCatalogueSoon(qc), [qc]);
  const price = a.currentPriceMinor ?? a.startPriceMinor;
  const priceLabel =
    a.status === "ENDED"
      ? a.outcome === "SOLD"
        ? "Sold for"
        : "Final bid"
      : a.currentPriceMinor === null
        ? "Starting bid"
        : "Current bid";
  const live = a.status === "LIVE";
  return (
    <article
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-xl border border-rule bg-paper shadow-card transition-[box-shadow,border-color] duration-200",
        "hover:border-control/60 hover:shadow-lift",
        "has-[a:focus-visible]:outline-3 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-hivis",
      )}
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-concrete">
        {a.coverUrl ? (
          <img
            src={a.coverUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
          />
        ) : (
          <BikePlaceholder label={a.title} className="size-full" />
        )}
        <div className="absolute top-3 left-3 flex flex-wrap gap-1.5 pr-24">
          <StatusBadge status={a.status} outcome={a.outcome} className="shadow-sm" />
          {a.repossessed && (
            <span className="inline-flex items-center rounded-full bg-paper/95 px-2.5 py-1 text-xs leading-none font-semibold text-asphalt shadow-sm">
              Bank repossessed
            </span>
          )}
        </div>
        {/* z-10 lifts it above the title link's full-card ::after overlay, so it stays clickable. */}
        <WatchButton auctionId={a.auctionId} className="absolute top-2 right-2 z-10" />
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 text-[1.0625rem] leading-snug font-bold">
            <Link
              to="/auctions/$auctionId"
              params={{ auctionId: a.auctionId }}
              className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none"
            >
              {a.make} {a.model}
              {a.variant && <span className="font-medium text-steel"> {a.variant}</span>}
            </Link>
          </h3>
          <GradeBadge grade={a.inspectionGrade} />
        </div>
        <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-sm text-steel tnum">
          <li>{a.manufactureYear}</li>
          <li>{formatKm(a.kmDriven)}</li>
          <li>{ownersLabel(a.ownerCount)}</li>
          {a.engineCc && <li>{a.engineCc} cc</li>}
          <li className="inline-flex items-center gap-1">
            <PinGlyph className="size-3.5" />
            {a.city}
          </li>
        </ul>

        <div className="mt-auto pt-4">
          <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1 border-t border-rule pt-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-steel">
                {priceLabel}
                {stale && live && <span className="font-normal"> (may be outdated)</span>}
              </p>
              <p className="font-expanded text-[1.625rem] leading-tight font-extrabold tracking-tight tnum">
                {formatINR(price)}
              </p>
            </div>
            <div className="ml-auto text-right text-sm">
              <p className="text-xs text-steel tnum">
                {a.bidCount} {a.bidCount === 1 ? "bid" : "bids"}
              </p>
              <p
                className={cn(
                  "mt-0.5 inline-flex items-center gap-1",
                  live ? "font-semibold text-asphalt" : "text-steel",
                )}
              >
                <ClockGlyph className="size-3.5" />
                <Countdown
                  status={a.status}
                  startsAt={a.startsAt}
                  closesAt={a.closesAt}
                  onDue={onDue}
                />
              </p>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

/** Mirrors the card's layout box for box, so nothing jumps when data arrives. */
export function CardSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex h-full flex-col overflow-hidden rounded-xl border border-rule bg-paper shadow-card"
    >
      <Skeleton className="aspect-[16/10] rounded-none" />
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <Skeleton className="h-5 w-3/5" />
          <Skeleton className="h-6 w-16 rounded-md" />
        </div>
        <Skeleton className="mt-2.5 h-4 w-4/5" />
        <Skeleton className="mt-2 h-4 w-1/3" />
        <div className="mt-4 flex items-end justify-between gap-3 border-t border-rule pt-3">
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-32" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="ml-auto h-3 w-10" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
      </div>
    </div>
  );
}
