/**
 * Metrics via Workers Analytics Engine (`writeDataPoint`, free and not billed on the Workers free
 * plan). The binding is OPTIONAL: when `METRICS` is not bound (unit tests, local dev without it, a
 * deploy that strips it) every call is a no-op. Writing never throws into the caller.
 *
 * Fixed schema (query with the AE SQL API; documented in docs/architecture.md → Observability):
 *
 *   index1  auctionId for auction events, else the route pattern (sampling key)
 *   blob1   event        http_request | bid_accepted | bid_rejected | max_bid_set | max_bid_rejected
 *                        | ws_connect | ws_disconnect | ws_error | projection_lag | projection_failure
 *                        | alarm_run | auction_lifecycle | auth_security | do_rpc_failure
 *   blob2   route        route PATTERN ("/api/v1/auctions/:id/bids"), never a raw URL; "" if n/a
 *   blob3   statusClass  "2xx" | "3xx" | "4xx" | "5xx" | ""
 *   blob4   outcome      bounded code: ErrorCode, bid kind, "ok", "error", "user" | "anon"
 *   blob5   status       exact HTTP status ("429") or ""
 *   blob6   colo         Cloudflare data-centre code (bounded, ~300) or ""
 *   blob7   version      deployed version (git SHA) or ""
 *   double1 durationMs   request / alarm / projection-lag duration (0 if n/a)
 *   double2 count        events in this point (bids committed, open sockets, events projected …)
 *   double3 value        event-specific gauge (projection lag in seq, consecutive failures …)
 *
 * Bounded cardinality by construction: blobs are enums, route patterns or codes. NEVER user ids,
 * e-mails, IPs, amounts that identify a bidder, reserves or maxima.
 */
export const METRIC_EVENTS = [
  "http_request",
  "bid_accepted",
  "bid_rejected",
  "max_bid_set",
  "max_bid_rejected",
  "ws_connect",
  "ws_disconnect",
  "ws_error",
  "projection_lag",
  "projection_failure",
  "alarm_run",
  "auction_lifecycle",
  "auth_security",
  "do_rpc_failure",
] as const;
export type MetricEvent = (typeof METRIC_EVENTS)[number];

export interface MetricPoint {
  event: MetricEvent;
  route?: string | undefined;
  status?: number | undefined;
  outcome?: string | undefined;
  colo?: string | undefined;
  version?: string | undefined;
  durationMs?: number | undefined;
  count?: number | undefined;
  value?: number | undefined;
  /** auctionId (auction events) or route; defaults to route, then event. */
  index?: string | undefined;
}

/** Minimal structural type so tests can pass a fake dataset. */
export interface MetricsSink {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

const BLOB_MAX = 96;
const INDEX_MAX = 96; // AE limit: one index of ≤ 96 bytes
const SAFE = /[^A-Za-z0-9_:./*\- ]/g;

const clean = (s: string | undefined, max = BLOB_MAX) => (s ?? "").replace(SAFE, "").slice(0, max);
const num = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? n : 0);

export function statusClass(status: number | undefined): string {
  if (!status || status < 100 || status > 599) return "";
  return `${Math.floor(status / 100)}xx`;
}

/** Pure: the exact datapoint written for a metric (exported for tests). */
export function toDataPoint(p: MetricPoint): {
  indexes: string[];
  blobs: string[];
  doubles: number[];
} {
  return {
    indexes: [clean(p.index ?? p.route ?? p.event, INDEX_MAX)],
    blobs: [
      p.event,
      clean(p.route),
      statusClass(p.status),
      clean(p.outcome),
      p.status ? String(p.status) : "",
      clean(p.colo, 8),
      clean(p.version, 40),
    ],
    doubles: [Math.max(0, num(p.durationMs)), num(p.count), num(p.value)],
  };
}

/** Writes one datapoint. No-op without a binding; never throws. */
export function writeMetric(sink: MetricsSink | undefined | null, p: MetricPoint): void {
  if (!sink) return;
  try {
    sink.writeDataPoint(toDataPoint(p));
  } catch {
    // Metrics are best effort: a full buffer or a bad point must never fail a request or a bid.
  }
}
