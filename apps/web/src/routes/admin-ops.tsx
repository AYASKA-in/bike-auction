import type { OpsAuctionRow, OpsHealth, OpsSummary } from "@bike/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import { StatusBadge } from "@/components/status";
import { Alert, Callout } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Fact, PageHeader, StatTile } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import * as t from "@/components/ui/table";
import { tabClass, tabListClass } from "@/components/ui/tabs";
import { apiSend } from "@/lib/api";
import { formatINR, formatISTTime } from "@/lib/format";
import { formatAge, HEALTH_COPY, OPS_REFRESH_MS, opsSummaryQuery } from "@/lib/ops";
import { authErrorMessage } from "@/lib/session";
import { cn } from "@/lib/utils";

/** Health is text + a shape, never colour alone (WCAG 1.4.1). */
export function HealthBadge({ health, className }: { health: OpsHealth; className?: string }) {
  const c = HEALTH_COPY[health];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs leading-none font-bold",
        c.tone === "ok" && "border-ledger/40 bg-ledger/10 text-ledger",
        c.tone === "warn" && "border-amber/45 bg-amber/10 text-amber",
        c.tone === "bad" && "border-danger-solid bg-danger-solid text-white",
        className,
      )}
    >
      <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
        {c.tone === "ok" ? (
          <path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="2" />
        ) : c.tone === "warn" ? (
          <path d="M6 1l5 9H1z" fill="currentColor" />
        ) : (
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="2" />
        )}
      </svg>
      {c.label}
    </span>
  );
}

const RetryResult = z.object({ pending: z.number() });

/** "Retry projection" (POST /admin/auctions/:id/retry-projection, audited server-side). */
export function RetryProjectionButton({
  auctionId,
  onDone,
  compact = false,
}: {
  auctionId: string;
  onDone?: () => void;
  compact?: boolean;
}) {
  const retry = useMutation({
    mutationFn: () =>
      apiSend(
        "POST",
        `/admin/auctions/${encodeURIComponent(auctionId)}/retry-projection`,
        undefined,
        (x) => RetryResult.parse(x),
      ),
    onSuccess: () => onDone?.(),
  });
  return (
    <div className={cn("flex flex-col gap-1", compact ? "items-end" : "items-start")}>
      <Button
        size="sm"
        variant="outline"
        className="whitespace-nowrap"
        onClick={() => retry.mutate()}
        loading={retry.isPending}
      >
        {retry.isPending ? "Retrying…" : "Retry projection"}
      </Button>
      <p className="min-h-4 text-xs text-steel" aria-live="polite">
        {retry.isSuccess &&
          (retry.data.pending === 0
            ? "Projection is up to date."
            : `${retry.data.pending} event(s) still pending; backoff continues.`)}
        {retry.isError && <span className="text-danger">{authErrorMessage(retry.error)}</span>}
      </p>
    </div>
  );
}

export function AdminOpsPage() {
  const qc = useQueryClient();
  const summary = useQuery(opsSummaryQuery);
  const refresh = () => void qc.invalidateQueries({ queryKey: opsSummaryQuery.queryKey });
  const g = summary.data?.global;
  const rows = summary.data?.auctions ?? [];

  return (
    <section className="mx-auto max-w-6xl px-4 pt-6 pb-14 sm:px-6">
      <AdminNav current="ops" />
      <PageHeader
        className="mt-6"
        title="Live operations"
        description={`Live auctions, viewers and read-model health. Refreshes every ${OPS_REFRESH_MS / 1000} s while this tab is visible.`}
        actions={
          <>
            {summary.data && (
              <p className="text-sm text-steel tnum" aria-live="polite">
                Updated {formatISTTime(summary.data.generatedAt)}
              </p>
            )}
            <Button variant="outline" onClick={refresh} loading={summary.isFetching}>
              {summary.isFetching ? "Refreshing…" : "Refresh"}
            </Button>
          </>
        }
      />

      {summary.data && <OverallBanner s={summary.data} />}

      <ul
        aria-label="Live totals"
        className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
      >
        <li>
          <Kpi label="Live auctions" value={g?.liveCount} />
        </li>
        <li>
          <Kpi label="Viewers (open sockets)" value={g?.totalViewers} />
        </li>
        <li>
          <Kpi label="Bids, last 5 min" value={g?.bidsLast5m} />
        </li>
        <li>
          <Kpi
            label="Outbox backlog (events)"
            value={g?.pendingOutboxTotal}
            alert={!!g?.pendingOutboxTotal && !!g?.auctionsWithLag}
          />
        </li>
        <li>
          <Kpi label="Lagging or failing" value={g?.auctionsWithLag} alert={!!g?.auctionsWithLag} />
        </li>
        <li>
          <Kpi
            label="Unreachable"
            value={g?.auctionsUnreachable}
            alert={!!g?.auctionsUnreachable}
          />
        </li>
      </ul>
      {g && (
        <p className="mt-3 text-sm text-steel tnum">
          D1 {g.d1.status === "ok" ? `reachable (${g.d1.latencyMs} ms)` : "UNAVAILABLE"} · Last
          successful D1 sync:{" "}
          {g.lastSuccessfulSyncAt === null ? "unavailable" : formatISTTime(g.lastSuccessfulSyncAt)}
          {" · "}Metrics {g.metricsBound ? "recording" : "not bound (no-op)"}
        </p>
      )}

      {summary.data && summary.data.warnings.length > 0 && (
        <section aria-labelledby="ops-warnings" className="mt-8">
          <h2 id="ops-warnings" className="text-lg font-bold">
            Warnings ({summary.data.warnings.length})
          </h2>
          <ul className="mt-3 divide-y divide-rule rounded-xl border border-rule bg-paper shadow-card">
            {summary.data.warnings.map((w, i) => (
              <li
                key={`${w.code}-${w.auctionId ?? "global"}-${i}`}
                className="flex gap-3 p-3 text-sm sm:p-4"
              >
                <span
                  className={cn(
                    "h-fit shrink-0 rounded-full px-2.5 py-1 text-xs leading-none font-bold",
                    w.severity === "critical"
                      ? "bg-danger-solid text-white"
                      : "border border-amber/45 bg-amber/10 text-amber",
                  )}
                >
                  {w.severity === "critical" ? "Critical" : "Warning"}
                </span>
                <span className="min-w-0">
                  <span className="font-mono text-xs text-steel">{w.code}</span>{" "}
                  {w.auctionId && (
                    <Link
                      to="/admin/auctions/$auctionId"
                      params={{ auctionId: w.auctionId }}
                      className="font-mono text-xs break-all underline underline-offset-4"
                    >
                      {w.auctionId}
                    </Link>
                  )}
                  <span className="block">{w.message}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary.isError && (
        <div className="mt-6">
          <Alert>
            Couldn&apos;t load the ops summary. {authErrorMessage(summary.error)} Figures below may
            be out of date.{" "}
            <button
              type="button"
              onClick={refresh}
              className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
            >
              Try again
            </button>
          </Alert>
        </div>
      )}
      {g?.truncated && (
        <Callout className="mt-6">
          Showing the {g.shown} auctions closing soonest of {g.liveCount} live. Open an auction from
          the desk for the rest.
        </Callout>
      )}

      <h2 className="mt-8 text-lg font-bold">Live auctions</h2>
      <div className="mt-3">
        {summary.isPending ? (
          <div className="space-y-2 rounded-xl border border-rule bg-paper p-4 shadow-card">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No auctions are live right now."
            body="Scheduled auctions appear here as soon as they open."
          />
        ) : (
          <>
            {/* Phones: one card per auction. */}
            <ul className="space-y-3 md:hidden">
              {rows.map((r) => (
                <li
                  key={r.auctionId}
                  className="space-y-3 rounded-xl border border-rule bg-paper p-4 shadow-card"
                >
                  <div className="flex items-start justify-between gap-3">
                    <AuctionLink r={r} />
                    <HealthBadge health={r.health} />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm min-[400px]:grid-cols-3">
                    <Fact label="Viewers">{orUnavailable(r.viewers)}</Fact>
                    <Fact label="Lag (events)">{orUnavailable(r.projectionLagSeq)}</Fact>
                    <Fact label="Oldest pending">{formatAge(r.oldestPendingAgeMs)}</Fact>
                    <Fact label="Bids (5 min)">{orUnavailable(r.bidsLast5m)}</Fact>
                    <Fact label="Bids">{r.bidCount}</Fact>
                    <Fact label="Last D1 sync">
                      {r.lastSyncSuccessAt === null
                        ? "Unavailable"
                        : formatISTTime(r.lastSyncSuccessAt)}
                    </Fact>
                    <Fact label="Price">{priceOf(r)}</Fact>
                    <Fact label="Closes">{formatISTTime(r.closesAt)}</Fact>
                  </dl>
                  <RowNote r={r} />
                  <RetryProjectionButton auctionId={r.auctionId} onDone={refresh} />
                </li>
              ))}
            </ul>
            {/* Tablets and up: a real table. */}
            <t.TableFrame label="Live auctions" className="hidden md:block">
              <table className={t.table}>
                <caption className="sr-only">
                  Live auctions with viewers, projection lag and health
                </caption>
                <thead className={t.thead}>
                  <tr>
                    <th scope="col" className={t.th}>
                      Auction
                    </th>
                    <th scope="col" className={t.th}>
                      Health
                    </th>
                    <th scope="col" className={cn(t.th, "text-right")}>
                      Viewers
                    </th>
                    <th scope="col" className={cn(t.th, "text-right")}>
                      Seq / projected
                    </th>
                    <th scope="col" className={cn(t.th, "text-right")}>
                      Oldest pending
                    </th>
                    <th scope="col" className={cn(t.th, "text-right")}>
                      Bids (5 min / all)
                    </th>
                    <th scope="col" className={t.th}>
                      Last D1 sync
                    </th>
                    <th scope="col" className={cn(t.th, "text-right")}>
                      Price
                    </th>
                    <th scope="col" className={t.th}>
                      Closes
                    </th>
                    <th scope="col" className={t.th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.auctionId} className={t.tr}>
                      <th scope="row" className={cn(t.rowHeader, "min-w-48")}>
                        <AuctionLink r={r} />
                        <RowNote r={r} />
                      </th>
                      <td className={t.td}>
                        <HealthBadge health={r.health} />
                      </td>
                      <td className={cn(t.td, t.num)}>{orUnavailable(r.viewers)}</td>
                      <td className={cn(t.td, t.num)}>
                        {r.seq === null ? "Unavailable" : `${r.seq} / ${r.projectedSeq}`}
                        {!!r.projectionLagSeq && (
                          <span className="block text-xs font-semibold text-amber">
                            {r.projectionLagSeq} behind
                          </span>
                        )}
                      </td>
                      <td className={cn(t.td, t.num)}>{formatAge(r.oldestPendingAgeMs)}</td>
                      <td className={cn(t.td, t.num)}>
                        {r.bidsLast5m === null ? "–" : r.bidsLast5m} / {r.bidCount}
                      </td>
                      <td className={cn(t.td, "tnum whitespace-nowrap")}>
                        {r.lastSyncSuccessAt === null
                          ? "Unavailable"
                          : formatISTTime(r.lastSyncSuccessAt)}
                      </td>
                      <td className={cn(t.td, t.num, "font-semibold")}>{priceOf(r)}</td>
                      <td className={cn(t.td, "tnum whitespace-nowrap")}>
                        {formatISTTime(r.closesAt)}
                      </td>
                      <td className={t.td}>
                        <RetryProjectionButton auctionId={r.auctionId} onDone={refresh} compact />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </t.TableFrame>
          </>
        )}
      </div>
    </section>
  );
}

const priceOf = (r: OpsAuctionRow) =>
  r.currentPriceMinor === null ? "No bids" : formatINR(r.currentPriceMinor);

/** null → "Unavailable" (never a made-up 0). */
const orUnavailable = (v: number | null) => (v === null ? "Unavailable" : v);

const OVERALL = {
  ok: { label: "All systems normal", cls: "border-ledger/40 bg-paper text-ledger" },
  degraded: { label: "Degraded: see warnings", cls: "border-amber/45 bg-paper text-amber" },
  down: {
    label: "Read path down (D1 unavailable)",
    cls: "border-danger-solid bg-danger-solid text-white",
  },
} as const;

function OverallBanner({ s }: { s: OpsSummary }) {
  const o = OVERALL[s.global.status];
  return (
    <p
      className={cn("mt-6 rounded-xl border px-4 py-3 font-semibold", o.cls)}
      data-ops-status={s.global.status}
    >
      Overall: {o.label}
    </p>
  );
}

function AuctionLink({ r }: { r: OpsAuctionRow }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <Link
        to="/admin/auctions/$auctionId"
        params={{ auctionId: r.auctionId }}
        className="inline-flex min-h-11 items-center font-semibold underline-offset-4 hover:underline"
      >
        {r.title}
      </Link>
      {r.status !== "LIVE" && <StatusBadge status={r.status} />}
    </span>
  );
}

const ERROR_COPY = {
  timeout: "The auction object didn't answer within 2 s.",
  unavailable: "The auction object returned an error.",
  not_found: "No auction object holds this id (read model only).",
} as const;

function RowNote({ r }: { r: OpsAuctionRow }) {
  if (r.error) return <p className="mt-1 text-xs font-normal text-danger">{ERROR_COPY[r.error]}</p>;
  if (r.lastSyncError)
    return (
      <p className="mt-1 max-w-80 text-xs font-normal break-words text-danger">
        Last sync error ({r.consecutiveFailures}×): {r.lastSyncError}
      </p>
    );
  return null;
}

function Kpi({
  label,
  value,
  alert,
}: {
  label: string;
  value?: number | null | undefined;
  alert?: boolean;
}) {
  return (
    <StatTile
      label={label}
      tone={alert ? "alert" : "default"}
      value={value === null ? <span className="text-base">Unavailable</span> : (value ?? "–")}
    />
  );
}

/** Secondary navigation between the admin areas (keeps the global app shell untouched). */
export function AdminNav({ current }: { current: "desk" | "ops" | "audit" | "bikes" }) {
  const items = [
    { key: "desk", to: "/admin", label: "Auction desk" },
    { key: "ops", to: "/admin/ops", label: "Live ops" },
    { key: "audit", to: "/admin/audit", label: "Audit trail" },
    { key: "bikes", to: "/admin/bikes", label: "Motorcycles" },
  ] as const;
  return (
    <nav aria-label="Admin">
      <ul className={tabListClass}>
        {items.map((i) => (
          <li key={i.key} className="shrink-0">
            <Link
              to={i.to}
              aria-current={current === i.key ? "page" : undefined}
              className={tabClass(current === i.key)}
            >
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
