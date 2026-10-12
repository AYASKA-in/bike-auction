import { HealthResponse } from "@bike/contracts";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiGet } from "./api";
import { bestSample, computeOffset, type ClockSample } from "./server-clock";

type Ctx = { sample: ClockSample | null; status: "syncing" | "synced" | "offline" };
const ServerClock = createContext<Ctx>({ sample: null, status: "syncing" });

/** One shared server-time sync for the whole app; every countdown derives from it. */
export function ServerClockProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Ctx>({ sample: null, status: "syncing" });
  useEffect(() => {
    const ctrl = new AbortController();
    let samples: ClockSample[] = [];
    const sync = async () => {
      try {
        const fresh: ClockSample[] = [];
        for (let i = 0; i < 3; i++) {
          const t0 = Date.now();
          const h = await apiGet("/health", (x) => HealthResponse.parse(x), ctrl.signal);
          fresh.push(computeOffset(t0, Date.parse(h.serverTime), Date.now()));
        }
        samples = [...fresh, ...samples].slice(0, 6);
        setState({ sample: bestSample(samples), status: "synced" });
      } catch {
        if (!ctrl.signal.aborted) setState((s) => ({ ...s, status: "offline" }));
      }
    };
    void sync();
    const t = setInterval(() => void sync(), 60_000);
    const onVisible = () => document.visibilityState === "visible" && void sync();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ctrl.abort();
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return <ServerClock.Provider value={state}>{children}</ServerClock.Provider>;
}

export function useServerClock(): Ctx {
  return useContext(ServerClock);
}

/** Server "now", re-rendering every `tickMs`. */
export function useServerNow(tickMs = 1000): number {
  const { sample } = useServerClock();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [tickMs]);
  return now + (sample?.offsetMs ?? 0);
}
