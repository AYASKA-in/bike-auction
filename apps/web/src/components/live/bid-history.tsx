import type { PublicBid } from "@bike/contracts";
import { useState } from "react";
import { formatINR, formatISTFull, relativeTime } from "@/lib/format";
import type { LiveState } from "@/lib/live-auction";
import type { LiveFeed } from "@/lib/live-feed";
import { useServerNow } from "@/lib/server-time";
import { cn } from "@/lib/utils";

/** Bid history: pseudonyms, relative time (server-corrected, shared ticker), your bids marked. */
export function BidHistory({ live, feed }: { live: LiveState; feed: LiveFeed | null }) {
  const [loading, setLoading] = useState(false);
  if (!live.view || live.view.bidCount === 0) return null;
  const more = live.olderCursor !== null && live.olderCursor !== undefined;
  return (
    <section
      aria-labelledby="bids-h"
      className="rounded-xl border border-rule bg-paper p-4 shadow-card sm:p-5"
    >
      <h2 id="bids-h" className="text-base font-bold">
        Recent bids
      </h2>
      {live.bids.length === 0 ? (
        <p className="mt-2 text-sm text-steel">Loading bids…</p>
      ) : (
        <BidRows bids={live.bids} />
      )}
      {more && (
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void feed?.loadOlder().finally(() => setLoading(false));
          }}
          className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4 hover:text-hivis-ink disabled:opacity-60"
        >
          {loading ? "Loading…" : "Load older bids"}
        </button>
      )}
    </section>
  );
}

/** Ticking leaf: only the rows re-render each second, not the whole panel. */
function BidRows({ bids }: { bids: readonly PublicBid[] }) {
  const now = useServerNow();
  return (
    <ol className="mt-2 divide-y divide-rule text-sm" data-testid="bid-history">
      {bids.map((b, i) => (
        <li
          key={b.seq}
          data-seq={b.seq}
          data-you={b.isYou || undefined}
          className={cn(
            "flex items-center justify-between gap-3 py-2",
            b.isYou && "-mx-2 rounded-md border-l-4 border-ledger bg-ledger/10 px-2",
            i === 0 && "font-semibold",
          )}
        >
          <span className="min-w-0">
            {b.bidder}
            {b.isYou && (
              <span className="ml-2 rounded bg-win px-1.5 py-0.5 text-xs font-bold text-white">
                You
              </span>
            )}
            {i === 0 && <span className="sr-only"> (highest)</span>}
          </span>
          <span className="text-right">
            <span className="tnum">{formatINR(b.amountMinor)}</span>
            <time
              dateTime={new Date(b.at).toISOString()}
              title={formatISTFull(b.at)}
              className="block text-xs font-normal text-steel tnum"
            >
              {relativeTime(b.at, now)}
            </time>
          </span>
        </li>
      ))}
    </ol>
  );
}
