/**
 * NTP-style offset between the auction server's clock and this device.
 * The browser clock never decides bid validity; this only drives the visual countdown.
 *   offset = serverTime - (t0 + t1) / 2      (t0 = request sent, t1 = response received)
 */
export type ClockSample = { offsetMs: number; rttMs: number; sampledAt: number };

export function computeOffset(t0: number, serverTime: number, t1: number): ClockSample {
  return {
    offsetMs: Math.round(serverTime - (t0 + t1) / 2),
    rttMs: Math.round(t1 - t0),
    sampledAt: t1,
  };
}

/** Prefer the sample with the smallest round trip: it bounds the error most tightly (±rtt/2). */
export function bestSample(samples: readonly ClockSample[]): ClockSample | null {
  return samples.reduce<ClockSample | null>(
    (best, s) => (best === null || s.rttMs < best.rttMs ? s : best),
    null,
  );
}

const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatIST(ms: number): string {
  return IST.format(ms);
}
