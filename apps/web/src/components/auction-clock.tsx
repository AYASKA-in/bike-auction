import { formatIST } from "@/lib/server-clock";
import { useServerClock, useServerNow } from "@/lib/server-time";
import { Skeleton } from "./ui/skeleton";

/**
 * The auction clock: server time, measured from this device. Every countdown in the product
 * derives from this offset; the server alone decides whether a bid was in time.
 */
export function AuctionClock() {
  const { sample, status } = useServerClock();
  const serverNow = useServerNow();
  return (
    <section
      aria-labelledby="clock-heading"
      className="relative overflow-hidden rounded-xl bg-asphalt p-6 text-paper shadow-[0_1px_0_#ffffff14_inset] sm:p-8"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="clock-heading" className="text-sm font-semibold text-paper/80">
          Auction clock, IST
        </h2>
        <ConnectionPill state={status} />
      </div>
      <p
        className="mt-4 font-expanded text-5xl font-extrabold tnum sm:text-6xl"
        aria-hidden={sample === null}
      >
        {sample === null ? <Skeleton className="h-14 w-64 bg-asphalt-2" /> : formatIST(serverNow)}
      </p>
      <p className="mt-4 max-w-sm text-sm text-paper/70">
        {sample
          ? `Your device is ${Math.abs(sample.offsetMs)} ms ${sample.offsetMs >= 0 ? "behind" : "ahead of"} the auction server (±${Math.ceil(sample.rttMs / 2)} ms). Countdowns use server time.`
          : "Measuring the difference between your device and the auction server."}
      </p>
    </section>
  );
}

function ConnectionPill({ state }: { state: "syncing" | "synced" | "offline" }) {
  const map = {
    syncing: { label: "Syncing", dot: "bg-paper/50 animate-pulse" },
    synced: { label: "In sync", dot: "bg-hivis" },
    offline: { label: "Can't reach server", dot: "bg-danger" },
  } as const;
  const { label, dot } = map[state];
  return (
    <span
      role="status"
      className="inline-flex items-center gap-2 rounded-full bg-asphalt-2 px-3 py-1 text-xs font-medium"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
