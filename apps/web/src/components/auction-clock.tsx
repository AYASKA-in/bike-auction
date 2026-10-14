import type { ReactNode } from "react";
import { formatIST } from "@/lib/server-clock";
import { useServerClock, useServerNow } from "@/lib/server-time";
import { Skeleton } from "./ui/skeleton";

/**
 * The auction clock: server time, measured from this device. Every countdown in the product
 * derives from this offset; the server alone decides whether a bid was in time.
 * `children` render below the clock on the same dark board (the home page's live lots).
 */
export function AuctionClock({ children }: { children?: ReactNode }) {
  const { sample, status } = useServerClock();
  const serverNow = useServerNow();
  return (
    <section
      aria-labelledby="clock-heading"
      className="relative overflow-hidden rounded-xl bg-pit text-pit-ink shadow-pop ring-1 ring-pit-line"
    >
      <div aria-hidden="true" className="hazard h-1.5" />
      <div className="p-5 sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 id="clock-heading" className="text-sm font-semibold text-pit-ink/80">
            Auction clock, IST
          </h2>
          <ConnectionPill state={status} />
        </div>
        <p
          className="mt-3 font-expanded text-5xl leading-none font-extrabold tracking-tight tnum sm:text-6xl"
          aria-hidden={sample === null}
        >
          {sample === null ? <Skeleton className="h-14 w-64 bg-pit-2" /> : formatIST(serverNow)}
        </p>
        <p className="mt-3 max-w-sm text-sm text-pit-ink/75">
          {sample
            ? `Your device is ${Math.abs(sample.offsetMs)} ms ${sample.offsetMs >= 0 ? "behind" : "ahead of"} the auction server (±${Math.ceil(sample.rttMs / 2)} ms). Countdowns use server time.`
            : "Measuring the difference between your device and the auction server."}
        </p>
      </div>
      {children}
    </section>
  );
}

function ConnectionPill({ state }: { state: "syncing" | "synced" | "offline" }) {
  const map = {
    syncing: { label: "Syncing", dot: "bg-pit-ink/50 animate-pulse" },
    synced: { label: "In sync", dot: "bg-go" },
    offline: { label: "Can't reach server", dot: "bg-danger-solid" },
  } as const;
  const { label, dot } = map[state];
  return (
    <span
      role="status"
      className="inline-flex items-center gap-2 rounded-full bg-pit-2 px-3 py-1 text-xs font-semibold"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
