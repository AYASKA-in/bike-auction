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

/** <input type="datetime-local"> value (interpreted as IST) → ISO string with +05:30. */
export function istLocalToIso(local: string): string {
  return `${local}:00+05:30`;
}
export function isoToIstLocal(ms: number): string {
  const d = new Date(ms + 5.5 * 3600_000);
  return d.toISOString().slice(0, 16);
}

export const rupeesToPaise = (r: number) => Math.round(r * 100);
