import { formatISTTime } from "@/lib/format";
import type { ConnStatus, LiveState } from "@/lib/live-auction";
import type { LiveFeed } from "@/lib/live-feed";
import { cn } from "@/lib/utils";

const CONN_COPY: Record<ConnStatus, { label: string; note?: string; dot: string }> = {
  connecting: { label: "Connecting…", dot: "animate-pulse bg-pit-ink/50" },
  live: { label: "Live", dot: "bg-go" },
  stale: {
    label: "Catching up…",
    note: "Some updates were missed. Refreshing from the server.",
    dot: "animate-pulse bg-caution",
  },
  reconnecting: {
    label: "Reconnecting…",
    note: "Connection lost. Figures below may be out of date.",
    dot: "animate-pulse bg-caution",
  },
  offline: {
    label: "Offline",
    note: "You're offline. Figures below may be out of date; bidding is paused.",
    dot: "bg-danger-solid",
  },
  failed: {
    label: "Connection failed",
    note: "We can't reach the live feed. Figures may be out of date.",
    dot: "bg-danger-solid",
  },
};

/**
 * Connection pill (Live ● / Reconnecting… / Offline). Deliberately not a live region: the page's
 * one polite region is reserved for bidding events; the bid button states why it's disabled.
 */
export function ConnectionIndicator({ live, feed }: { live: LiveState; feed: LiveFeed | null }) {
  const c = CONN_COPY[live.status];
  return (
    <div className="text-xs">
      <p
        className="inline-flex items-center gap-2 rounded-full bg-pit-2 px-2.5 py-1 font-semibold"
        data-conn={live.status}
      >
        <span aria-hidden="true" className={cn("size-2 rounded-full", c.dot)} />
        {c.label}
      </p>
      {c.note && live.view && (
        <p className="mt-2 text-pit-ink/75">
          {c.note}
          {live.syncedAt !== null && <> Last updated {formatISTTime(live.syncedAt)}.</>}
          {(live.status === "failed" || live.status === "reconnecting") && feed && (
            <button
              type="button"
              onClick={() => feed.retryNow()}
              className="ml-1 inline-flex min-h-11 items-center px-1 font-semibold underline underline-offset-2"
            >
              Retry now
            </button>
          )}
        </p>
      )}
    </div>
  );
}
