import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { StatusBadge } from "@/components/status";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LoadError } from "@/components/ui/empty-state";
import { controlClass } from "@/components/ui/form";
import { Card, Fact, PageHeader } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import * as t from "@/components/ui/table";
import { apiSend } from "@/lib/api";
import { formatINR, formatIST, formatISTTime } from "@/lib/format";
import type { ConnStatus } from "@/lib/live-auction";
import {
  adminAuctionOpsQuery,
  adminLedgerQuery,
  formatAge,
  healthOfOps,
  type AuctionOps,
} from "@/lib/ops";
import { authErrorMessage } from "@/lib/session";
import { useLiveAuction } from "@/lib/use-live-auction";
import { cn } from "@/lib/utils";
import { AdminNav, HealthBadge, RetryProjectionButton } from "./admin-ops";

const CONN: Record<ConnStatus, string> = {
  connecting: "Connecting to live feed…",
  live: "Live feed connected",
  stale: "Live feed catching up…",
  reconnecting: "Live feed reconnecting…",
  offline: "Offline",
  failed: "Live feed unavailable",
};

/**
 * Per-auction live ops (admin). Price/state come from the same read-only live feed buyers use;
 * ops numbers from GET /admin/auctions/:id (polled every 5 s while visible); the ledger from the
 * admin ledger endpoint (pseudonymous, with bid kind; no maxima).
 */
export function AdminAuctionPage() {
  const { auctionId } = useParams({ from: "/admin/auctions/$auctionId" });
  const qc = useQueryClient();
  const detail = useQuery(adminAuctionOpsQuery(auctionId));
  const { state: live } = useLiveAuction(auctionId, detail.data?.view);
  const view = live.view ?? detail.data?.view ?? null;
  const ledger = useInfiniteQuery(adminLedgerQuery(auctionId));
  const refreshAll = () => void qc.invalidateQueries({ queryKey: ["admin", "auction", auctionId] });

  // A new accepted seq on the live feed → reload the ledger (authoritative rows).
  const seq = view?.seq;
  useEffect(() => {
    if (seq !== undefined)
      void qc.invalidateQueries({ queryKey: ["admin", "auction", auctionId, "ledger"] });
  }, [seq, auctionId, qc]);

  if (detail.isError && !detail.data)
    return (
      <section className="mx-auto max-w-6xl px-4 pt-6 pb-14 sm:px-6">
        <AdminNav current="ops" />
        <LoadError
          className="mt-6"
          title="Couldn't load this auction."
          detail={authErrorMessage(detail.error)}
          onRetry={() => void detail.refetch()}
        />
      </section>
    );

  const ops = detail.data?.ops;
  const title = detail.data?.listing?.title ?? auctionId;
  const open = view && ["DRAFT", "SCHEDULED", "LIVE"].includes(view.status);

  return (
    <section className="mx-auto max-w-6xl px-4 pt-6 pb-14 sm:px-6">
      <AdminNav current="ops" />
      <PageHeader
        className="mt-6"
        context={<span className="font-mono text-xs break-all">{auctionId}</span>}
        title={detail.isPending ? <Skeleton className="h-10 w-72 max-w-full" /> : title}
        meta={
          <>
            {view && <StatusBadge status={view.status} outcome={view.outcome} />}
            <span
              className="inline-flex items-center gap-1.5 text-steel"
              data-conn={live.status}
              aria-live="polite"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 rounded-full",
                  live.status === "live"
                    ? "bg-ledger"
                    : live.status === "offline" || live.status === "failed"
                      ? "bg-danger"
                      : "bg-amber",
                )}
              />
              {CONN[live.status]}
            </span>
          </>
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link to="/auctions/$auctionId" params={{ auctionId }}>
                Buyer view
              </Link>
            </Button>
            {detail.data?.listing && (
              <Button asChild variant="outline" size="sm">
                <Link to="/admin/bikes/$bikeId" params={{ bikeId: detail.data.listing.bikeId }}>
                  Motorcycle
                </Link>
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/audit" search={{ resourceId: auctionId }}>
                Audit trail
              </Link>
            </Button>
          </>
        }
      />

      {/* State */}
      <Panel title="Auction state">
        {!view ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
            <Fact label="Current price">
              {view.currentPriceMinor === null
                ? `No bids (start ${formatINR(view.startPriceMinor)})`
                : formatINR(view.currentPriceMinor)}
            </Fact>
            <Fact label="Bids">{view.bidCount}</Fact>
            <Fact label="Accepted seq">{view.seq}</Fact>
            <Fact label="Leader">{view.leadingBidder ?? "None"}</Fact>
            <Fact label="Starts">{formatIST(view.startsAt)}</Fact>
            <Fact label="Closes (deadline)">{formatIST(view.closesAt)}</Fact>
            <Fact label="Anti-sniping extensions">{view.extensionCount}</Fact>
            <Fact label="Reserve">
              {!view.hasReserve ? "No reserve" : view.reserveMet ? "Met" : "Not met"}
            </Fact>
          </dl>
        )}
      </Panel>

      {/* Ops */}
      <Panel
        title="Operations"
        action={<RetryProjectionButton auctionId={auctionId} onDone={refreshAll} compact />}
      >
        {!ops ? (
          detail.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <p className="text-steel">Unavailable</p>
          )
        ) : (
          <OpsFacts ops={ops} now={detail.dataUpdatedAt} />
        )}
        {detail.isError && detail.data && (
          <p className="mt-3 text-sm text-danger">
            Refresh failed; showing the last values received.
          </p>
        )}
      </Panel>

      {/* Ledger */}
      <Panel
        title="Bid ledger"
        description="Authoritative, newest first. Bidders are per-auction pseudonyms; automatic bids are placed from a hidden maximum, which is never shown."
      >
        {ledger.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : ledger.isError ? (
          <LoadError
            title="Couldn't load the bid ledger."
            detail={authErrorMessage(ledger.error)}
            onRetry={() => void ledger.refetch()}
          />
        ) : (
          <LedgerTable pages={ledger.data.pages} />
        )}
        {ledger.hasNextPage && (
          <div className="mt-3">
            <Button
              variant="secondary"
              onClick={() => void ledger.fetchNextPage()}
              loading={ledger.isFetchingNextPage}
            >
              {ledger.isFetchingNextPage ? "Loading…" : "Load older bids"}
            </Button>
          </div>
        )}
      </Panel>

      {open && <CancelPanel auctionId={auctionId} onDone={refreshAll} />}
    </section>
  );
}

/** `now` = when these ops were fetched (overdue is judged at that instant, not at render). */
function OpsFacts({ ops, now }: { ops: AuctionOps; now: number }) {
  const lag = Math.max(0, ops.seq - ops.projectedSeq);
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        <Fact label="Health">
          <HealthBadge health={healthOfOps(ops)} />
        </Fact>
        <Fact label="Viewers (open sockets)">{ops.connections}</Fact>
        <Fact label="Seq / projected to D1">
          {ops.seq} / {ops.projectedSeq}
          {lag > 0 && <span className="block text-xs text-amber">{lag} behind</span>}
        </Fact>
        <Fact label="Outbox backlog">
          {ops.pendingOutbox} event(s)
          {ops.oldestPendingAgeMs !== null && (
            <span className="block text-xs text-steel">
              oldest {formatAge(ops.oldestPendingAgeMs)}
            </span>
          )}
        </Fact>
        <Fact label="Last successful D1 sync">
          {ops.sync.lastSuccessAt === null ? "Never" : formatISTTime(ops.sync.lastSuccessAt)}
        </Fact>
        <Fact label="Last sync attempt">
          {ops.sync.lastAttemptAt === null ? "Never" : formatISTTime(ops.sync.lastAttemptAt)}
        </Fact>
        <Fact label="Consecutive sync failures">{ops.sync.consecutiveFailures}</Fact>
      </dl>
      {ops.sync.lastError && (
        <p className="mt-4 rounded-md border border-danger/35 bg-danger/8 px-3 py-2 text-sm font-medium break-words text-danger">
          Recent sync failure: {ops.sync.lastError}
        </p>
      )}
      <h3 className="mt-6 text-sm font-bold">Scheduled timers</h3>
      {ops.timers.length === 0 ? (
        <p className="text-sm text-steel">None scheduled.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm tnum">
          {ops.timers.map((t) => (
            <li key={t.kind}>
              <span className="font-mono">{t.kind}</span> due {formatIST(t.dueAt)}
              {t.dueAt < now - 60_000 && (
                <span className="ml-2 font-semibold text-danger">
                  overdue by {formatAge(now - t.dueAt)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function LedgerTable({
  pages,
}: {
  pages: {
    items: {
      seq: number;
      bidder: string;
      amountMinor: number;
      kind: "MANUAL" | "PROXY";
      at: number;
      isLeading: boolean;
    }[];
  }[];
}) {
  const rows = pages.flatMap((p) => p.items);
  if (rows.length === 0)
    return (
      <p className="rounded-md border border-dashed border-control/50 px-4 py-6 text-center text-steel">
        No bids yet.
      </p>
    );
  return (
    <t.TableFrame label="Bid ledger" className="rounded-lg border border-rule">
      <table className={cn(t.table, "min-w-[32rem]")}>
        <caption className="sr-only">Accepted bids, newest first</caption>
        <thead className={t.thead}>
          <tr>
            <th scope="col" className={cn(t.th, "text-right")}>
              Seq
            </th>
            <th scope="col" className={t.th}>
              Bidder
            </th>
            <th scope="col" className={cn(t.th, "text-right")}>
              Amount
            </th>
            <th scope="col" className={t.th}>
              Kind
            </th>
            <th scope="col" className={t.th}>
              Time (IST)
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.seq} className={t.tr}>
              <td className={cn(t.td, t.num, "py-2.5")}>{b.seq}</td>
              <th scope="row" className={cn(t.rowHeader, "py-2.5")}>
                {b.bidder}
                {b.isLeading && (
                  <span className="ml-2 inline-flex items-center rounded-full border border-ledger/40 bg-ledger/10 px-2 py-0.5 text-xs font-bold text-ledger">
                    Leading
                  </span>
                )}
              </th>
              <td className={cn(t.td, t.num, "py-2.5 font-semibold")}>
                {formatINR(b.amountMinor)}
              </td>
              <td className={cn(t.td, "py-2.5")}>{b.kind === "PROXY" ? "Automatic" : "Manual"}</td>
              <td className={cn(t.td, "py-2.5 tnum")}>{formatISTTime(b.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </t.TableFrame>
  );
}

function CancelPanel({ auctionId, onDone }: { auctionId: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    mutationFn: () =>
      apiSend(
        "POST",
        `/admin/auctions/${encodeURIComponent(auctionId)}/cancel`,
        { reason },
        (x) => x,
      ),
    onSuccess: () => {
      setConfirming(false);
      onDone();
    },
  });
  return (
    <Panel
      title="Cancel auction"
      description="Bidders see the reason; the cancellation is recorded in the audit trail."
    >
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setConfirming(true);
        }}
      >
        <label className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5 text-sm font-semibold">
          Reason (shown to bidders; recorded in the audit trail)
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={3}
            maxLength={500}
            required
            className={cn(controlClass, "h-11 font-normal")}
          />
        </label>
        <Button type="submit" variant="danger" disabled={reason.trim().length < 3}>
          Cancel auction…
        </Button>
        {cancel.isError && !confirming && (
          <div className="w-full">
            <Alert>{authErrorMessage(cancel.error)}</Alert>
          </div>
        )}
      </form>
      <ConfirmDialog
        open={confirming}
        title="Cancel this auction?"
        confirmLabel={cancel.isPending ? "Cancelling…" : "Confirm: cancel auction"}
        cancelLabel="Keep it"
        busy={cancel.isPending}
        onConfirm={() => cancel.mutate()}
        onCancel={() => setConfirming(false)}
      >
        <p>This cannot be undone. Bidders will see this reason:</p>
        <p className="mt-2 rounded-md bg-concrete px-3 py-2 font-medium break-words text-asphalt">
          {reason}
        </p>
        {cancel.isError && (
          <p className="mt-3 font-semibold text-danger">{authErrorMessage(cancel.error)}</p>
        )}
      </ConfirmDialog>
    </Panel>
  );
}

function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card title={title} description={description} action={action} className="mt-6" as="section">
      {children}
    </Card>
  );
}
