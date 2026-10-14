import {
  AdminLedgerPage,
  AuditFacets,
  AuditPage,
  OpsSummary,
  PROJECTION_LAG_SLO_MS,
  PublicAuctionView,
  type OpsHealth,
} from "@bike/contracts";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { apiGet } from "./api";

/**
 * Admin observability client (Day 8). Polling pauses while the tab is hidden: TanStack Query's
 * `refetchInterval` does not run in the background unless `refetchIntervalInBackground` is set.
 */

export const OPS_REFRESH_MS = 10_000;

export const opsSummaryQuery = queryOptions({
  queryKey: ["admin", "ops", "summary"],
  queryFn: ({ signal }) => apiGet("/admin/ops/summary", (x) => OpsSummary.parse(x), signal),
  refetchInterval: OPS_REFRESH_MS,
  refetchIntervalInBackground: false,
});

/** Ops block of GET /admin/auctions/:id (the DO's `ops()`); loose on purpose (admin-internal). */
export const AuctionOps = z.object({
  seq: z.number(),
  projectedSeq: z.number(),
  pendingOutbox: z.number(),
  oldestPendingAgeMs: z.number().nullable(),
  sync: z.object({
    lastAttemptAt: z.number().nullable(),
    lastSuccessAt: z.number().nullable(),
    consecutiveFailures: z.number(),
    lastError: z.string().nullable(),
  }),
  connections: z.number(),
  timers: z.array(z.object({ kind: z.string(), dueAt: z.number() })),
});
export type AuctionOps = z.infer<typeof AuctionOps>;

export const AdminAuctionOpsDetail = z.object({
  state: z.object({ auctionId: z.string(), status: z.string(), closesAt: z.number() }),
  view: PublicAuctionView,
  ops: AuctionOps,
  listing: z.object({ bikeId: z.string(), title: z.string() }).nullable(),
});
export type AdminAuctionOpsDetail = z.infer<typeof AdminAuctionOpsDetail>;

export const adminAuctionOpsQuery = (auctionId: string) =>
  queryOptions({
    queryKey: ["admin", "auction", auctionId, "ops"],
    queryFn: ({ signal }) =>
      apiGet(
        `/admin/auctions/${encodeURIComponent(auctionId)}`,
        (x) => AdminAuctionOpsDetail.parse(x),
        signal,
      ),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });

export const LEDGER_PAGE = 25;

export const adminLedgerQuery = (auctionId: string) =>
  infiniteQueryOptions({
    queryKey: ["admin", "auction", auctionId, "ledger"],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) =>
      apiGet(
        `/admin/auctions/${encodeURIComponent(auctionId)}/ledger?limit=${LEDGER_PAGE}${pageParam ? `&beforeSeq=${pageParam}` : ""}`,
        (x) => AdminLedgerPage.parse(x),
        signal,
      ),
    getNextPageParam: (last) => last.nextBeforeSeq,
  });

// ───────────────────────────── audit ─────────────────────────────

/** URL search state of /admin/audit (validated; bad values fall back to "no filter"). */
export const AuditSearch = z.object({
  action: z
    .string()
    .regex(/^[A-Z][A-Z_]{2,39}$/)
    .optional()
    .catch(undefined),
  actorId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional()
    .catch(undefined),
  /** Affected record id (auction or bike id). */
  resourceId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional()
    .catch(undefined),
  /** IST calendar days, YYYY-MM-DD (inclusive range). */
  fromDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  toDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
});
export type AuditSearch = z.infer<typeof AuditSearch>;

const IST_OFFSET = "+05:30";

/** Start of an IST calendar day in epoch ms (null if invalid). */
export function istDayStart(day: string): number | null {
  const ms = Date.parse(`${day}T00:00:00${IST_OFFSET}`);
  return Number.isFinite(ms) ? ms : null;
}

/** API query string for an audit page: dates become [fromDay 00:00 IST, toDay+1 00:00 IST). */
export function auditQueryString(s: AuditSearch, cursor: string | null, limit = 50): string {
  const p = new URLSearchParams();
  if (s.action) p.set("action", s.action);
  if (s.actorId) p.set("actorId", s.actorId);
  if (s.resourceId) p.set("resourceId", s.resourceId);
  const from = s.fromDay ? istDayStart(s.fromDay) : null;
  const toStart = s.toDay ? istDayStart(s.toDay) : null;
  if (from !== null) p.set("from", String(from));
  if (toStart !== null) p.set("to", String(toStart + 24 * 60 * 60 * 1000));
  if (cursor) p.set("cursor", cursor);
  p.set("limit", String(limit));
  return p.toString();
}

export const auditQuery = (s: AuditSearch) =>
  infiniteQueryOptions({
    queryKey: ["admin", "audit", s],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      apiGet(`/admin/audit?${auditQueryString(s, pageParam)}`, (x) => AuditPage.parse(x), signal),
    getNextPageParam: (last) => last.nextCursor,
  });

export const auditFacetsQuery = queryOptions({
  queryKey: ["admin", "audit", "facets"],
  queryFn: ({ signal }) => apiGet("/admin/audit/facets", (x) => AuditFacets.parse(x), signal),
  staleTime: 60_000,
});

/** "AUCTION_CREATED" → "Auction created". */
export function actionLabel(action: string): string {
  const s = action.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Compact one-line metadata ("reason: Bike sold privately · fields: closesAt"). */
export function metadataSummary(meta: Record<string, unknown>, max = 160): string {
  const parts = Object.entries(meta).map(([k, v]) => {
    const val = Array.isArray(v) ? v.join(", ") : typeof v === "object" && v ? "…" : String(v);
    return `${k}: ${val}`;
  });
  const s = parts.join(" · ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ───────────────────────────── health copy ─────────────────────────────

export const HEALTH_COPY: Record<OpsHealth, { label: string; tone: "ok" | "warn" | "bad" }> = {
  ok: { label: "Healthy", tone: "ok" },
  lagging: { label: "Projection lagging", tone: "warn" },
  failing: { label: "Projection failing", tone: "bad" },
  unreachable: { label: "Unreachable", tone: "bad" },
};

/** Health of a single auction from its detailed ops (same rule as the server summary). */
export function healthOfOps(o: AuctionOps): OpsHealth {
  if (o.sync.consecutiveFailures > 0) return "failing";
  if ((o.oldestPendingAgeMs ?? 0) > PROJECTION_LAG_SLO_MS) return "lagging";
  return "ok";
}

/** "0 ms", "850 ms", "4.2 s", "3 min" — compact ages for ops tables. */
export function formatAge(ms: number | null): string {
  if (ms === null) return "–";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}
