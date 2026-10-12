import { HealthResponse } from "@bike/contracts";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { bestSample, computeOffset, formatIST, type ClockSample } from "@/lib/server-clock";
import { Skeleton } from "./ui/skeleton";

type ClockState =
  | { kind: "syncing" }
  | { kind: "synced"; sample: ClockSample }
  | { kind: "offline"; sample: ClockSample | null };

async function sampleOnce(signal: AbortSignal): Promise<ClockSample> {
  const t0 = Date.now();
  const h = await apiGet("/health", (x) => HealthResponse.parse(x), signal);
  return computeOffset(t0, Date.parse(h.serverTime), Date.now());
}

/**
 * The auction clock: server time, measured from this device. Every countdown in the product
 * derives from this offset; the server alone decides whether a bid was in time.
 */
export function AuctionClock() {
  const [state, setState] = useState<ClockState>({ kind: "syncing" });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const ctrl = new AbortController();
    let samples: ClockSample[] = [];
    const sync = async () => {
      try {
        const fresh: ClockSample[] = [];
        for (let i = 0; i < 3; i++) fresh.push(await sampleOnce(ctrl.signal));
        samples = [...fresh, ...samples].slice(0, 6);
        const best = bestSample(samples);
        if (best) setState({ kind: "synced", sample: best });
      } catch {
        if (!ctrl.signal.aborted)
          setState((s) => ({ kind: "offline", sample: s.kind === "syncing" ? null : s.sample }));
      }
    };
    void sync();
    const resync = setInterval(() => void sync(), 60_000);
    const onVisible = () => document.visibilityState === "visible" && void sync();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ctrl.abort();
      clearInterval(resync);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, []);

  const sample = state.kind === "syncing" ? null : state.sample;
  const serverNow = sample ? now + sample.offsetMs : null;

  return (
    <section
      aria-labelledby="clock-heading"
      className="relative overflow-hidden rounded-xl bg-asphalt p-6 text-paper shadow-[0_1px_0_#ffffff14_inset] sm:p-8"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="clock-heading" className="text-sm font-semibold text-paper/80">
          Auction clock, IST
        </h2>
        <ConnectionPill state={state.kind} />
      </div>
      <p
        className="mt-4 font-expanded text-5xl font-extrabold tnum sm:text-6xl"
        aria-hidden={serverNow === null}
      >
        {serverNow === null ? (
          <Skeleton className="h-14 w-64 bg-asphalt-2" />
        ) : (
          formatIST(serverNow)
        )}
      </p>
      <p className="mt-4 max-w-sm text-sm text-paper/70">
        {sample
          ? `Your device is ${Math.abs(sample.offsetMs)} ms ${sample.offsetMs >= 0 ? "behind" : "ahead of"} the auction server (±${Math.ceil(sample.rttMs / 2)} ms). Countdowns use server time.`
          : "Measuring the difference between your device and the auction server."}
      </p>
    </section>
  );
}

function ConnectionPill({ state }: { state: ClockState["kind"] }) {
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
