import type { MyBidCard, MyBidsTab } from "@bike/contracts";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Countdown } from "@/components/countdown";
import { BikePlaceholder, StatusBadge } from "@/components/status";
import { StaleNotice } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadError } from "@/components/ui/empty-state";
import { tabClass, tabListClass } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { formatINR } from "@/lib/format";
import { adjacentTab, MY_BIDS_TABS, myBidsQuery, parseMyBidsTab, refreshMineSoon } from "@/lib/me";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/utils";

export function MyBidsPage() {
  const search = useSearch({ from: "/me/bids" });
  const tab = parseMyBidsTab(search.tab);
  const navigate = useNavigate({ from: "/me/bids" });
  const me = useMe();
  const userId = me.data?.id ?? "-";
  const tabRefs = useRef<Partial<Record<MyBidsTab, HTMLButtonElement | null>>>({});

  const select = (t: MyBidsTab, focus = false) => {
    void navigate({ search: { tab: t === "leading" ? undefined : t }, replace: true });
    if (focus) tabRefs.current[t]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key;
    if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
    e.preventDefault();
    const next =
      key === "Home"
        ? "leading"
        : key === "End"
          ? "lost"
          : adjacentTab(tab, key === "ArrowRight" ? 1 : -1);
    select(next, true);
  };

  return (
    <section className="mx-auto max-w-6xl px-4 pt-8 pb-14 sm:px-6 sm:pt-10">
      <header>
        <h1 className="font-expanded text-3xl font-extrabold tracking-tight sm:text-4xl">
          My bids
        </h1>
        <p className="mt-1.5 max-w-prose text-steel">
          Every auction you've bid on. Prices refresh every 30 seconds; open an auction for the live
          feed.
        </p>
      </header>

      <div
        role="tablist"
        aria-label="Bid status"
        onKeyDown={onKeyDown}
        className={cn("mt-6", tabListClass)}
      >
        {MY_BIDS_TABS.map((t) => {
          const selected = tab === t.value;
          return (
            <button
              key={t.value}
              ref={(el) => {
                tabRefs.current[t.value] = el;
              }}
              id={`tab-${t.value}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls="my-bids-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => select(t.value)}
              className={tabClass(selected)}
            >
              <TabGlyph tab={t.value} />
              {t.label}
            </button>
          );
        })}
      </div>

      <div id="my-bids-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="mt-6">
        {me.data && <TabPanel key={tab} userId={userId} tab={tab} />}
        {me.isPending && <ListSkeleton />}
      </div>
    </section>
  );
}

function TabPanel({ userId, tab }: { userId: string; tab: MyBidsTab }) {
  const list = useInfiniteQuery(myBidsQuery(userId, tab));
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  if (list.isPending) return <ListSkeleton />;
  if (list.isError && !list.data) {
    return <LoadError title="Couldn't load your bids." onRetry={() => void list.refetch()} />;
  }
  if (items.length === 0) return <TabEmpty tab={tab} />;
  return (
    <>
      {list.isRefetchError && (
        <StaleNotice>
          Couldn't refresh. Prices shown may be out of date; retrying automatically.
        </StaleNotice>
      )}
      <ul className="space-y-3">
        {items.map((b) => (
          <li key={b.auctionId}>
            <BidRow b={b} tab={tab} userId={userId} />
          </li>
        ))}
      </ul>
      {list.hasNextPage && (
        <div className="mt-8 text-center">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </>
  );
}

/** Your position in words + icon (colour is never the only signal). */
function PositionChip({ tab, b }: { tab: MyBidsTab; b: MyBidCard }) {
  const chip = {
    leading: { text: "You're leading", cls: "bg-ledger/10 text-ledger border-ledger/30" },
    outbid: { text: "Outbid", cls: "bg-amber/10 text-amber border-amber/40" },
    won: { text: "You won", cls: "bg-win text-white border-win" },
    lost: {
      text: b.status === "CANCELLED" ? "Cancelled" : "Not won",
      cls: "bg-concrete text-steel border-rule",
    },
  }[tab];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold",
        chip.cls,
      )}
    >
      <TabGlyph tab={tab} />
      {chip.text}
    </span>
  );
}

function BidRow({ b, tab, userId }: { b: MyBidCard; tab: MyBidsTab; userId: string }) {
  const qc = useQueryClient();
  const onDue = useCallback(() => refreshMineSoon(qc, userId), [qc, userId]);
  const live = b.status === "LIVE";
  const gap =
    tab === "outbid" && b.currentPriceMinor !== null ? b.currentPriceMinor - b.myHighestMinor : 0;
  return (
    <article
      className={cn(
        "group relative grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-xl border bg-paper p-3 shadow-card transition-shadow hover:shadow-lift sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center sm:p-4",
        "has-[a:focus-visible]:outline-3 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-hivis",
        tab === "outbid"
          ? "border-amber/50 border-l-4"
          : tab === "won"
            ? "border-ledger/50 border-l-4"
            : "border-rule",
      )}
    >
      <div className="row-span-2 aspect-[4/3] self-start overflow-hidden rounded-lg bg-concrete sm:row-span-1">
        {b.coverUrl ? (
          <img src={b.coverUrl} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <BikePlaceholder label={b.title} className="size-full" />
        )}
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <PositionChip tab={tab} b={b} />
          <StatusBadge status={b.status} outcome={b.outcome} />
        </div>
        <h2 className="mt-2 truncate text-base leading-snug font-bold sm:text-lg">
          <Link
            to="/auctions/$auctionId"
            params={{ auctionId: b.auctionId }}
            className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none"
          >
            {b.title}
          </Link>
        </h2>
        <p className="mt-0.5 text-sm text-steel">
          <Countdown status={b.status} startsAt={b.startsAt} closesAt={b.closesAt} onDue={onDue} />
          {" · "}
          <span className="tnum">
            {b.bidCount} {b.bidCount === 1 ? "bid" : "bids"}
          </span>
        </p>
      </div>

      <div className="col-span-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-t border-rule pt-3 sm:col-span-1 sm:col-start-3 sm:border-0 sm:pt-0 sm:justify-end">
        <dl className="flex gap-5 sm:gap-6">
          <Stat label="Your highest">{formatINR(b.myHighestMinor)}</Stat>
          <Stat
            label={live ? "Current bid" : b.outcome === "SOLD" ? "Sold for" : "Final bid"}
            strong
          >
            {b.currentPriceMinor === null ? "—" : formatINR(b.currentPriceMinor)}
          </Stat>
        </dl>
        {tab === "outbid" && (
          <Button asChild size="md" className="relative z-10">
            <Link
              to="/auctions/$auctionId"
              params={{ auctionId: b.auctionId }}
              hash="live-panel"
              aria-label={`Bid again on ${b.title}`}
            >
              Bid again
            </Link>
          </Button>
        )}
        {tab === "outbid" && gap > 0 && (
          <p className="w-full text-right text-xs font-semibold text-amber sm:order-last">
            {formatINR(gap)} above your bid
          </p>
        )}
        {tab === "won" && (
          <p className="w-full text-sm font-semibold text-ledger sm:max-w-64 sm:text-right">
            Our team will contact you about payment and collection.
          </p>
        )}
      </div>
    </article>
  );
}

function Stat({
  label,
  strong,
  children,
}: {
  label: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="text-right">
      <dt className="text-xs font-semibold text-steel">{label}</dt>
      <dd
        className={cn(
          "tnum font-bold",
          strong ? "font-expanded text-xl font-extrabold" : "text-base",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

const EMPTY: Record<MyBidsTab, { title: string; body: string; cta: string }> = {
  leading: {
    title: "You're not leading any live auction",
    body: "When your bid is the highest on a live auction, it shows up here with its countdown.",
    cta: "Find a bike to bid on",
  },
  outbid: {
    title: "Nobody has outbid you",
    body: "If someone tops your bid on a live auction, it lands here with a one-tap way back in.",
    cta: "Browse live auctions",
  },
  won: {
    title: "No wins yet",
    body: "Auctions you win appear here. Our team contacts winners about payment and collection.",
    cta: "See what's ending soon",
  },
  lost: {
    title: "Nothing here",
    body: "Finished auctions you bid on but didn't win (including cancelled ones) are kept here.",
    cta: "Browse auctions",
  },
};

function TabEmpty({ tab }: { tab: MyBidsTab }) {
  const e = EMPTY[tab];
  return (
    <EmptyState
      title={e.title}
      body={e.body}
      action={
        <Button asChild variant="secondary">
          <Link to="/auctions" search={tab === "won" || tab === "lost" ? {} : { status: "LIVE" }}>
            {e.cta}
          </Link>
        </Button>
      }
    />
  );
}

function ListSkeleton() {
  return (
    <ul aria-hidden="true" className="space-y-3">
      {Array.from({ length: 3 }, (_, i) => (
        <li
          key={i}
          className="grid grid-cols-[5.5rem_1fr] items-center gap-4 rounded-xl border border-rule bg-paper p-3 shadow-card sm:grid-cols-[8rem_1fr_12rem] sm:p-4"
        >
          <Skeleton className="aspect-[4/3] rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
          <Skeleton className="hidden h-10 sm:block" />
        </li>
      ))}
    </ul>
  );
}

function TabGlyph({ tab, className }: { tab: MyBidsTab; className?: string }) {
  const paths: Record<MyBidsTab, ReactNode> = {
    leading: <path d="M4 10.5l4 4 8-9" />,
    outbid: <path d="M10 15V5M5.5 9.5L10 5l4.5 4.5" />,
    won: (
      <>
        <path d="M6 3.5h8v4a4 4 0 0 1-8 0z" />
        <path d="M10 11.5v3M7 16.5h6M6 5H3.5a2.5 2.5 0 0 0 2.6 3M14 5h2.5a2.5 2.5 0 0 1-2.6 3" />
      </>
    ),
    lost: <path d="M5 10h10" />,
  };
  return (
    <svg
      viewBox="0 0 20 20"
      className={cn("size-3.5 shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[tab]}
    </svg>
  );
}
