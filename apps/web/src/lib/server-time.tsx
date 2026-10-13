import { HealthResponse } from "@bike/contracts";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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

// One shared 1 s ticker for every countdown on the page (not one interval per card). Only the
// components that read it re-render; ticks align to wall-clock seconds so digits change together.
const tickListeners = new Set<() => void>();
let tickNow = Date.now();
let tickTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleTick() {
  tickTimer = setTimeout(
    () => {
      tickNow = Date.now();
      for (const l of tickListeners) l();
      scheduleTick();
    },
    1000 - (Date.now() % 1000) + 5,
  );
}
function subscribeTick(fn: () => void) {
  tickListeners.add(fn);
  if (tickListeners.size === 1) {
    tickNow = Date.now();
    scheduleTick();
  }
  return () => {
    tickListeners.delete(fn);
    if (tickListeners.size === 0) clearTimeout(tickTimer);
  };
}
const getTick = () => tickNow;

/** Server "now" (device clock corrected by the measured offset), updated once per second. */
export function useServerNow(): number {
  const { sample } = useServerClock();
  const now = useSyncExternalStore(subscribeTick, getTick, getTick);
  return now + (sample?.offsetMs ?? 0);
}
