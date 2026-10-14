import { WATCHLIST_MAX, type WatchlistItem } from "@bike/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AuctionCard, CardSkeleton } from "@/components/auction-card";
import { Alert, StaleNotice } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadError } from "@/components/ui/empty-state";
import { formatIST } from "@/lib/format";
import { useToggleWatch, watchErrorMessage, watchlistQuery } from "@/lib/me";
import { useMe } from "@/lib/session";

export function WatchlistPage() {
  const me = useMe();
  const userId = me.data?.id ?? "-";
  const list = useQuery({ ...watchlistQuery(userId), enabled: Boolean(me.data) });
  const items = list.data?.items ?? [];
  const error = useWatchlistRemovalError(items);

  return (
    <section className="mx-auto max-w-6xl px-4 pt-8 pb-14 sm:px-6 sm:pt-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-expanded text-3xl font-extrabold tracking-tight sm:text-4xl">
            Watchlist
          </h1>
          <p className="mt-1.5 max-w-prose text-steel">
            Auctions you're keeping an eye on, with their price and countdown.
          </p>
        </div>
        {list.data && (
          <p
            className="rounded-full border border-rule bg-paper px-3 py-1 text-sm font-semibold text-steel tnum"
            aria-live="polite"
          >
            {items.length} of {WATCHLIST_MAX} watched
          </p>
        )}
      </header>

      <div className="mt-6">
        {error.message && (
          <Alert className="mb-4">
            <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <span>{error.message}</span>
              <button
                type="button"
                onClick={error.dismiss}
                className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
              >
                Dismiss
              </button>
            </span>
          </Alert>
        )}
        {list.isPending ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : list.isError && !list.data ? (
          <LoadError title="Couldn't load your watchlist." onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title="Nothing on your watchlist yet"
            body={
              <>
                Tap <span className="font-semibold text-asphalt">Watch</span> on any auction to keep
                it here, with its price and countdown in one place.
              </>
            }
            action={
              <Button asChild variant="secondary">
                <Link to="/auctions">Browse auctions</Link>
              </Button>
            }
          />
        ) : (
          <>
            {list.isRefetchError && (
              <StaleNotice>
                Couldn't refresh. Prices shown may be out of date; retrying automatically.
              </StaleNotice>
            )}
            <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((a) => (
                <li key={a.auctionId} className="flex flex-col gap-1">
                  <AuctionCard a={a} stale={list.isRefetchError} />
                  <RemoveRow userId={userId} item={a} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * A failed removal (from the card's Watch toggle or the Remove button) rolls the card back, which
 * remounts it and would drop any error shown on the card, and per-call mutate callbacks don't run
 * once the optimistic removal has unmounted the row. So the page listens to the mutation cache and
 * keeps the message visible until the user dismisses it or tries again.
 */
function useWatchlistRemovalError(items: readonly WatchlistItem[]) {
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  // Titles of watched lots, so the message can name one that was optimistically removed.
  const titles = useRef(new Map<string, string>());
  useEffect(() => {
    for (const i of items) titles.current.set(i.auctionId, i.title);
  }, [items]);
  useEffect(
    () =>
      qc.getMutationCache().subscribe((e) => {
        if (e.type !== "updated") return;
        const vars = e.mutation.state.variables as
          { auctionId?: unknown; watch?: unknown } | undefined;
        if (!vars || typeof vars.auctionId !== "string" || vars.watch !== false) return;
        if (e.action.type === "pending") setMessage(null);
        else if (e.action.type === "error") {
          const name = titles.current.get(vars.auctionId);
          const why = watchErrorMessage(e.action.error);
          setMessage(name ? `${name} is still on your watchlist. ${why}` : why);
        }
      }),
    [qc],
  );
  return { message, dismiss: () => setMessage(null) };
}

function RemoveRow({ userId, item }: { userId: string; item: WatchlistItem }) {
  const toggle = useToggleWatch(userId);
  return (
    <div className="flex items-center justify-between gap-3 pl-1">
      <p className="text-xs text-steel">Watching since {formatIST(item.watchedAt)}</p>
      <Button
        variant="ghost"
        size="sm"
        className="text-steel hover:text-danger"
        disabled={toggle.isPending}
        aria-label={`Remove ${item.title} from your watchlist`}
        onClick={() => toggle.mutate({ auctionId: item.auctionId, watch: false })}
      >
        Remove
      </Button>
    </div>
  );
}
