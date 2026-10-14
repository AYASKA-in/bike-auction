import { z } from "zod";
import { AuctionStatus, BidKind } from "./auction";

/**
 * Admin observability contracts (Day 8). Every object is STRICT so a leaked field (a user id, an
 * e-mail, a reserve amount, a hidden maximum) fails parsing in tests instead of reaching a screen.
 * Data minimisation: admins see bidder PSEUDONYMS only, never e-mails or user ids, in ops and
 * ledger views. Identifying a bidder (e.g. for a dispute) is an offline, audited DB procedure.
 */

/** Projection lag SLO (BLUEPRINT §9.1: p95 < 5 s). Older pending events mark an auction "lagging". */
export const PROJECTION_LAG_SLO_MS = 5_000;
/** At most this many live auctions are inspected per summary call (one DO RPC each). */
export const OPS_SUMMARY_MAX_AUCTIONS = 50;

/**
 * ok          projection caught up (or pending for less than the SLO)
 * lagging     events pending longer than the SLO, no failed attempt yet
 * failing     the last D1 projection attempt(s) failed (backoff running)
 * unreachable the auction object did not answer in time / threw / has no state
 */
export const OpsHealth = z.enum(["ok", "lagging", "failing", "unreachable"]);
export type OpsHealth = z.infer<typeof OpsHealth>;

export const OpsAuctionError = z.enum(["timeout", "unavailable", "not_found"]);
export type OpsAuctionError = z.infer<typeof OpsAuctionError>;

const Int = z.number().int();
const NonNeg = z.number().int().nonnegative();

export const OpsAuctionRow = z.strictObject({
  auctionId: z.string(),
  title: z.string(),
  /** Authoritative status from the object when reachable, else the read model's effective status. */
  status: AuctionStatus,
  health: OpsHealth,
  /** Why the object's numbers are missing (null when it answered). */
  error: OpsAuctionError.nullable(),
  seq: NonNeg.nullable(),
  projectedSeq: NonNeg.nullable(),
  projectionLagSeq: NonNeg.nullable(),
  pendingOutbox: NonNeg.nullable(),
  oldestPendingAgeMs: NonNeg.nullable(),
  /** Open WebSockets on the object (anonymous + signed-in viewers). */
  viewers: NonNeg.nullable(),
  consecutiveFailures: NonNeg.nullable(),
  /** Last D1 projection error message (truncated, e-mail-masked); null when healthy. */
  lastSyncError: z.string().max(300).nullable(),
  lastSyncSuccessAt: Int.nullable(),
  /** From the read model when the object is unreachable (never invented). */
  bidCount: NonNeg,
  currentPriceMinor: Int.nullable(),
  closesAt: Int,
  extensionCount: NonNeg.nullable(),
  /** Accepted bids in the last 5 minutes (authoritative ledger); null when unreachable. */
  bidsLast5m: NonNeg.nullable(),
  lastBidAt: Int.nullable(),
  overdueTimers: NonNeg.nullable(),
  deadlineOverdue: z.boolean().nullable(),
  /** Last alarm failure since the object instance started (memory only); null if none/unknown. */
  lastAlarmError: z.strictObject({ at: Int, message: z.string().max(300) }).nullable(),
});
export type OpsAuctionRow = z.infer<typeof OpsAuctionRow>;

export const OpsWarningCode = z.enum([
  "D1_UNAVAILABLE",
  "PROJECTION_LAGGING",
  "PROJECTION_FAILING",
  "AUCTION_UNREACHABLE",
  "DEADLINE_OVERDUE",
  "TIMER_OVERDUE",
  "ALARM_FAILED",
  "READ_MODEL_STALE",
  "METRICS_UNBOUND",
  "TRUNCATED",
]);
export type OpsWarningCode = z.infer<typeof OpsWarningCode>;

export const OpsWarning = z.strictObject({
  code: OpsWarningCode,
  severity: z.enum(["warn", "critical"]),
  auctionId: z.string().nullable(),
  message: z.string(),
});
export type OpsWarning = z.infer<typeof OpsWarning>;

/** ok = no warnings · degraded = warnings · down = D1 (the read path) is unavailable. */
export const OpsOverall = z.enum(["ok", "degraded", "down"]);

export const OpsSummary = z.strictObject({
  generatedAt: Int,
  global: z.strictObject({
    status: OpsOverall,
    d1: z.strictObject({ status: z.enum(["ok", "down"]), latencyMs: NonNeg }),
    /** Whether the Analytics Engine binding is present (metrics are a no-op without it). */
    metricsBound: z.boolean(),
    /** All live auctions in the read model (may exceed `shown`); null when D1 is down. */
    liveCount: NonNeg.nullable(),
    shown: NonNeg,
    truncated: z.boolean(),
    totalViewers: NonNeg,
    /** Rows whose health is "lagging" or "failing". */
    auctionsWithLag: NonNeg,
    auctionsUnreachable: NonNeg,
    pendingOutboxTotal: NonNeg,
    bidsLast5m: NonNeg,
    /** Newest successful D1 projection among the shown auctions; null if none known. */
    lastSuccessfulSyncAt: Int.nullable(),
  }),
  warnings: z.array(OpsWarning),
  auctions: z.array(OpsAuctionRow),
});
export type OpsSummary = z.infer<typeof OpsSummary>;

/** Admin readiness (detailed); the public /status stays minimal. No DO fan-out: cheap to poll. */
export const AdminHealth = z.strictObject({
  status: OpsOverall,
  version: z.string(),
  environment: z.string(),
  serverTime: Int,
  checks: z.strictObject({
    d1: z.strictObject({ status: z.enum(["ok", "down"]), latencyMs: NonNeg }),
    metricsBound: z.boolean(),
  }),
  /** Read-model anomalies (D1 only): READ_MODEL_STALE rows, bounded. */
  warnings: z.array(OpsWarning),
});
export type AdminHealth = z.infer<typeof AdminHealth>;

/** One accepted bid as admins see it: pseudonymous, with its kind; no user id, no maximum. */
export const AdminLedgerBid = z.strictObject({
  seq: z.number().int().positive(),
  bidId: z.string(),
  bidder: z.string(),
  amountMinor: z.number().int().positive(),
  kind: BidKind,
  at: Int,
  /** The newest accepted bid (current leader). */
  isLeading: z.boolean(),
});
export type AdminLedgerBid = z.infer<typeof AdminLedgerBid>;

export const AdminLedgerPage = z.strictObject({
  auctionId: z.string(),
  items: z.array(AdminLedgerBid),
  nextBeforeSeq: z.number().int().positive().nullable(),
});
export type AdminLedgerPage = z.infer<typeof AdminLedgerPage>;

export const AuditAction = z.string().regex(/^[A-Z][A-Z_]{2,39}$/);

export const AuditEntry = z.strictObject({
  id: z.string(),
  action: z.string(),
  /** The acting admin. Name only: admins' e-mails are not needed to read the trail. */
  actor: z.strictObject({ id: z.string(), name: z.string().nullable() }),
  resourceType: z.string(),
  resourceId: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  requestId: z.string(),
  createdAt: Int,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditPage = z.strictObject({
  items: z.array(AuditEntry),
  nextCursor: z.string().nullable(),
});
export type AuditPage = z.infer<typeof AuditPage>;

/** GET /admin/audit query. `from`/`to` are epoch ms (inclusive / exclusive). */
export const AuditQuery = z.strictObject({
  action: AuditAction.optional(),
  actorId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  resourceType: z.enum(["auction", "bike"]).optional(),
  resourceId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().positive().optional(),
  cursor: z
    .string()
    .regex(/^\d{1,16}_[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditFacets = z.strictObject({
  actions: z.array(z.string()),
  actors: z.array(z.strictObject({ id: z.string(), name: z.string().nullable() })),
});
export type AuditFacets = z.infer<typeof AuditFacets>;
