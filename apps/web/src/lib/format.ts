import { formatINR } from "@bike/domain";

export { formatINR };

export const formatKm = (km: number) => `${new Intl.NumberFormat("en-IN").format(km)} km`;

export function ownersLabel(n: number) {
  return n === 1 ? "1st owner" : n === 2 ? "2nd owner" : n === 3 ? "3rd owner" : `${n}th owner`;
}

/** "2h 05m", "3d 4h", "45s". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s % 60}s`;
}

/** Countdown with seconds: "2d 03h 04m 05s", "3h 04m 05s", "4m 05s", "5s". Never negative. */
export function durationFull(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = `${String(s % 60).padStart(2, "0")}s`;
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${p2(h)}h ${p2(m)}m ${ss}`;
  if (h > 0) return `${h}h ${p2(m)}m ${ss}`;
  if (m > 0) return `${m}m ${ss}`;
  return `${s % 60}s`;
}

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
/** "4:05:09 pm" in IST, for bid-history rows. */
export const formatISTTime = (ms: number) => IST_TIME.format(ms);

const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});
export const formatIST = (ms: number) => `${IST.format(ms)} IST`;

/**
 * Relative age of an event against a (server-corrected) now: "just now", "45s ago", "2 min ago",
 * "3 h ago", "2 d ago". A timestamp slightly in the future (clock skew) reads "just now".
 */
export function relativeTime(atMs: number, nowMs: number): string {
  const s = Math.floor((nowMs - atMs) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

const upperDayPeriod = (s: string) =>
  s.replace(/\s*\b(am|pm)\b/i, (x) => ` ${x.trim().toUpperCase()}`);

const IST_CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const IST_DAY_KEY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const IST_DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** "9:42 PM IST". */
export const formatISTClock = (ms: number) => `${upperDayPeriod(IST_CLOCK.format(ms))} IST`;

/**
 * Absolute end time for the live panel: "9:42 PM IST" when it falls on the same IST calendar day
 * as `nowMs`, otherwise "Wed, 14 Oct, 9:42 PM IST".
 */
export function formatEndsAt(ms: number, nowMs: number): string {
  if (IST_DAY_KEY.format(ms) === IST_DAY_KEY.format(nowMs)) return formatISTClock(ms);
  return `${IST_DATE.format(ms)}, ${formatISTClock(ms)}`;
}

const IST_FULL = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});
/** "14 Oct 2026, 9:42:05 PM IST": exact time for tooltips. */
export const formatISTFull = (ms: number) => `${upperDayPeriod(IST_FULL.format(ms))} IST`;

/** Soft-close extension amount as a chip label: 120_000 → "+2:00", 45_400 → "+0:45". */
export function formatExtension(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** <input type="datetime-local"> value (interpreted as IST) → ISO string with +05:30. */
export function istLocalToIso(local: string): string {
  return `${local}:00+05:30`;
}
export function isoToIstLocal(ms: number): string {
  const d = new Date(ms + 5.5 * 3600_000);
  return d.toISOString().slice(0, 16);
}

export const rupeesToPaise = (r: number) => Math.round(r * 100);
