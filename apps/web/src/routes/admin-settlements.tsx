import type { AdminSettlement, Payment } from "@bike/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, LoadError } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { SelectField, TextAreaField } from "@/components/ui/form";
import { Card, Fact, PageHeader, StatTile } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { TableFrame, table, td, th, thead, tr, num } from "@/components/ui/table";
import { tabClass, tabListClass } from "@/components/ui/tabs";
import { duration, formatINR, formatIST, rupeesToPaise } from "@/lib/format";
import { useServerNow } from "@/lib/server-time";
import {
  ADMIN_FILTERS,
  adminDepositsQuery,
  adminSettlementQuery,
  adminSettlementsQuery,
  AUDIT_LABEL,
  settlementErrorMessage,
  STATUS_TONE,
  useAdminAction,
  type AdminFilter,
} from "@/lib/settlement";
import { cn } from "@/lib/utils";
import { AdminNav } from "./admin-ops";

const ADMIN_STATUS: Record<AdminSettlement["status"], string> = {
  OFFERED: "Offer sent",
  AWAITING_INITIAL: "Awaiting 25%",
  AWAITING_BALANCE: "Awaiting balance",
  PAID: "Paid, to collect",
  COLLECTED: "Collected",
  DEFAULTED: "Defaulted",
  CANCELLED: "Cancelled",
  DECLINED: "Offer declined",
  EXPIRED: "Offer expired",
};
const chip: Record<string, string> = {
  action: "border-hivis/60 bg-hivis/12 text-asphalt",
  good: "border-ledger/40 bg-ledger/10 text-ledger",
  bad: "border-danger/40 bg-danger/8 text-danger",
  neutral: "border-rule bg-concrete text-steel",
};
function Status({ s }: { s: AdminSettlement }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2 py-0.5 text-xs font-bold whitespace-nowrap",
        chip[STATUS_TONE[s.status]],
      )}
    >
      {ADMIN_STATUS[s.status]}
    </span>
  );
}

function Due({ s }: { s: AdminSettlement }) {
  const now = useServerNow();
  if (s.dueBy === null) return <span className="text-steel">–</span>;
  const left = s.dueBy - now;
  const urgent = left < 2 * 3_600_000;
  return (
    <span className={cn("whitespace-nowrap", urgent && "font-semibold text-danger")}>
      {s.dueNowMinor > 0 ? formatINR(s.dueNowMinor) : "Covered"}
      <span className="block text-xs">
        {left > 0 ? `${duration(left)} left` : "overdue"}
        {urgent && <span className="sr-only"> (urgent)</span>}
      </span>
    </span>
  );
}

/** Settlements queue: every sale after the hammer, nearest deadline first. */
export function AdminSettlementsPage() {
  const search = useSearch({ from: "/admin/settlements" });
  const navigate = useNavigate({ from: "/admin/settlements" });
  const filter: AdminFilter = search.status ?? "open";
  const q = useQuery(adminSettlementsQuery(filter));
  const counts = q.data?.counts ?? {};
  const n = (...k: string[]) => k.reduce((s, x) => s + (counts[x] ?? 0), 0);
  const toVerify = (q.data?.items ?? []).reduce((s, x) => s + x.pendingReports, 0);
  return (
    <section className="mx-auto max-w-6xl px-4 pt-6 pb-14 sm:px-6">
      <AdminNav current="settlements" />
      <PageHeader
        className="mt-6"
        title="Settlements"
        description="Payments after the hammer: 25% within 24 hours, the balance within 15 days. Deadlines are enforced automatically."
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/deposits">Deposits</Link>
          </Button>
        }
      />
      <ul aria-label="Settlement counts" className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <li>
          <StatTile label="Awaiting payment" value={n("AWAITING_INITIAL", "AWAITING_BALANCE")} />
        </li>
        <li>
          <StatTile
            label="Payments to verify"
            value={filter === "open" || filter === "awaiting_verification" ? toVerify : "–"}
            tone={toVerify > 0 ? "alert" : "default"}
          />
        </li>
        <li>
          <StatTile label="Ready to collect" value={n("PAID")} />
        </li>
        <li>
          <StatTile label="Defaulted" value={n("DEFAULTED")} />
        </li>
      </ul>
      <nav aria-label="Filter settlements" className="mt-6">
        <ul className={tabListClass}>
          {ADMIN_FILTERS.map((f) => (
            <li key={f.value} className="shrink-0">
              <button
                type="button"
                aria-pressed={filter === f.value}
                className={tabClass(filter === f.value)}
                onClick={() =>
                  void navigate({ search: { status: f.value === "open" ? undefined : f.value } })
                }
              >
                {f.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-4">
        {q.isPending ? (
          <Skeleton className="h-48 w-full rounded-xl" />
        ) : q.isError || !q.data ? (
          <LoadError title="Couldn't load settlements." onRetry={() => void q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState
            title="Nothing here"
            body="Sold auctions appear here as soon as they close."
          />
        ) : (
          <TableFrame label="Settlements">
            <table className={table}>
              <thead className={thead}>
                <tr>
                  <th scope="col" className={th}>
                    Bike
                  </th>
                  <th scope="col" className={th}>
                    Buyer
                  </th>
                  <th scope="col" className={th}>
                    Stage
                  </th>
                  <th scope="col" className={cn(th, num)}>
                    Price
                  </th>
                  <th scope="col" className={th}>
                    Due
                  </th>
                  <th scope="col" className={th}>
                    To verify
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((s) => (
                  <tr key={s.id} className={tr}>
                    <th scope="row" className={cn(td, "text-left font-semibold")}>
                      <Link
                        to="/admin/settlements/$settlementId"
                        params={{ settlementId: s.id }}
                        className="underline-offset-4 hover:underline"
                      >
                        {s.title}
                      </Link>
                      {s.attempt > 1 && (
                        <span className="block text-xs font-normal text-steel">
                          Runner-up offer #{s.attempt - 1}
                        </span>
                      )}
                    </th>
                    <td className={td}>
                      {s.buyer.name}
                      <span className="block text-xs text-steel">
                        {s.buyer.email}
                        {s.buyer.defaults > 0 &&
                          ` · ${s.buyer.defaults} default${s.buyer.defaults > 1 ? "s" : ""}`}
                      </span>
                    </td>
                    <td className={td}>
                      <Status s={s} />
                    </td>
                    <td className={cn(td, num)}>{formatINR(s.priceMinor)}</td>
                    <td className={td}>
                      <Due s={s} />
                    </td>
                    <td className={td}>
                      {s.pendingReports > 0 ? (
                        <span className="font-semibold">{s.pendingReports}</span>
                      ) : (
                        "–"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </div>
    </section>
  );
}

/** One settlement: money, deadlines, payments to verify, and every admin action. */
export function AdminSettlementPage() {
  const { settlementId } = useParams({ from: "/admin/settlements/$settlementId" });
  const q = useQuery(adminSettlementQuery(settlementId));
  const act = useAdminAction();
  const navigate = useNavigate();
  if (q.isPending)
    return (
      <Shell>
        <Skeleton className="mt-6 h-64 w-full rounded-xl" />
      </Shell>
    );
  if (q.isError || !q.data)
    return (
      <Shell>
        <LoadError title="Couldn't load this settlement." onRetry={() => void q.refetch()} />
      </Shell>
    );
  const { item: s, timeline } = q.data;
  const owing = s.status === "AWAITING_INITIAL" || s.status === "AWAITING_BALANCE";
  const run = (path: string, body?: unknown, after?: (x: unknown) => void) =>
    act.mutate({ path: `/settlements/${s.id}${path}`, body }, after ? { onSuccess: after } : {});
  return (
    <Shell>
      <PageHeader
        className="mt-6"
        context={
          <Link to="/admin/settlements" className="font-semibold hover:underline">
            ← Settlements
          </Link>
        }
        title={s.title}
        meta={<Status s={s} />}
        description={`${s.attempt > 1 ? `Runner-up offer #${s.attempt - 1}` : "Winner"}: ${s.buyer.name} (${s.buyer.email})`}
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/auctions/$auctionId" params={{ auctionId: s.auctionId }}>
              Auction
            </Link>
          </Button>
        }
      />
      {act.isError && <Alert className="mt-4">{settlementErrorMessage(act.error)}</Alert>}
      {s.buyer.suspended && (
        <Alert tone="caution" className="mt-4">
          Bidding is paused for this buyer ({s.buyer.defaults} default
          {s.buyer.defaults === 1 ? "" : "s"}). <Reinstate userId={s.buyer.id} />
        </Alert>
      )}
      <div className="mt-6 grid gap-5 lg:grid-cols-3">
        <Card title="Money" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Fact label="Price">{formatINR(s.priceMinor)}</Fact>
            <Fact label="Fee + GST">{formatINR(s.feeMinor + s.gstMinor)}</Fact>
            <Fact label="Deposit counted">{formatINR(s.depositMinor)}</Fact>
            <Fact label="Verified paid">{formatINR(s.paidMinor)}</Fact>
            <Fact label="Due now">{formatINR(s.dueNowMinor)}</Fact>
            <Fact label="Due by">{s.dueBy ? formatIST(s.dueBy) : "–"}</Fact>
            <Fact label="25% deadline">
              {s.initialDeadline ? formatIST(s.initialDeadline) : "–"}
            </Fact>
            <Fact label="Balance deadline">
              {s.balanceDeadline ? formatIST(s.balanceDeadline) : "–"}
            </Fact>
          </dl>
          {s.closedReason && <p className="mt-4 text-sm font-semibold">{s.closedReason}</p>}
          {s.refundDueMinor > 0 && (
            <p className="mt-2 text-sm">
              Refund due: {formatINR(s.refundDueMinor)}{" "}
              {s.refundedAt ? (
                `(paid ${formatIST(s.refundedAt)})`
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-2"
                  onClick={() => run("/refunded")}
                >
                  Mark refund paid
                </Button>
              )}
            </p>
          )}
        </Card>
        <Card title="Actions">
          <div className="flex flex-col gap-3">
            {owing && (
              <RecordPayment onSubmit={(body) => run("/payments", body)} busy={act.isPending} />
            )}
            {owing && s.extensionMs === 0 && (
              <Extend onSubmit={(body) => run("/extend", body)} busy={act.isPending} />
            )}
            {s.status === "PAID" && (
              <Collect
                onSubmit={(gatePass) => run("/collect", { gatePass })}
                busy={act.isPending}
              />
            )}
            {["DEFAULTED", "DECLINED", "EXPIRED"].includes(s.status) && !s.nextStep && (
              <Button onClick={() => run("/offer-runner-up")} loading={act.isPending}>
                Offer to the runner-up
              </Button>
            )}
            {["DEFAULTED", "DECLINED", "EXPIRED", "CANCELLED"].includes(s.status) &&
              !s.nextStep && (
                <Button
                  variant="outline"
                  onClick={() =>
                    run(
                      "/relist",
                      undefined,
                      (x) =>
                        void navigate({
                          to: "/admin/bikes/$bikeId",
                          params: { bikeId: (x as { bikeId: string }).bikeId },
                          hash: "auction",
                        }),
                    )
                  }
                >
                  Relist the bike
                </Button>
              )}
            {s.nextStep && (
              <p className="text-sm font-semibold">
                {s.nextStep === "RELISTED" ? "Marked for relisting." : "Offered to the runner-up."}
              </p>
            )}
            {["OFFERED", "AWAITING_INITIAL", "AWAITING_BALANCE", "PAID"].includes(s.status) && (
              <Cancel onSubmit={(reason) => run("/cancel", { reason })} busy={act.isPending} />
            )}
            {!owing &&
              !["PAID", "DEFAULTED", "DECLINED", "EXPIRED", "CANCELLED", "OFFERED"].includes(
                s.status,
              ) && <p className="text-sm text-steel">No actions needed.</p>}
          </div>
        </Card>
      </div>
      <Card title="Payments" className="mt-5">
        {s.payments.length === 0 ? (
          <p className="text-sm text-steel">No payments reported yet.</p>
        ) : (
          <ul className="divide-y divide-rule text-sm">
            {s.payments.map((p) => (
              <PaymentRow
                key={p.id}
                p={p}
                onDecide={(decision, reason) =>
                  run(`/payments/${p.id}/${decision}`, reason ? { reason } : undefined)
                }
                busy={act.isPending}
              />
            ))}
          </ul>
        )}
      </Card>
      <Card title="Timeline" className="mt-5">
        <ol className="space-y-2 text-sm">
          <li>Opened {formatIST(s.startAt)}</li>
          {timeline.map((t, i) => (
            <li key={i}>
              <span className="font-semibold">{AUDIT_LABEL[t.action] ?? t.action}</span>
              <span className="text-steel">
                {" "}
                · {t.actor ?? "System"} · {formatIST(t.at)}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <section className="mx-auto max-w-6xl px-4 pt-6 pb-14 sm:px-6">
      <AdminNav current="settlements" />
      {children}
    </section>
  );
}

function PaymentRow({
  p,
  onDecide,
  busy,
}: {
  p: Payment;
  onDecide: (d: "verify" | "reject", reason?: string) => void;
  busy: boolean;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <span>
        <span className="font-semibold">{formatINR(p.amountMinor)}</span> ·{" "}
        {p.method.replace("_", " ").toLowerCase()} · ref{" "}
        <span className="font-mono">{p.reference}</span>
        <span className="block text-xs text-steel">
          {p.recordedByAdmin ? "Recorded by an admin" : "Reported by the buyer"} ·{" "}
          {formatIST(p.reportedAt)}
          {p.rejectReason && ` · ${p.rejectReason}`}
        </span>
      </span>
      {p.status === "REPORTED" ? (
        <span className="flex gap-2">
          <Button size="sm" onClick={() => onDecide("verify")} loading={busy}>
            Verify
          </Button>
          <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
            Reject
          </Button>
        </span>
      ) : (
        <span
          className={cn("font-semibold", p.status === "VERIFIED" ? "text-ledger" : "text-danger")}
        >
          {p.status === "VERIFIED" ? "Verified" : "Rejected"}
        </span>
      )}
      <ConfirmDialog
        open={rejecting}
        title="Reject this payment?"
        confirmLabel="Reject payment"
        busy={busy}
        onCancel={() => setRejecting(false)}
        onConfirm={() => {
          if (reason.trim().length < 5) return;
          onDecide("reject", reason.trim());
          setRejecting(false);
        }}
      >
        <TextAreaField
          label="Reason (shown to the buyer)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="At least 5 characters, e.g. 'No credit with this UTR on 14 Oct'."
        />
      </ConfirmDialog>
    </li>
  );
}

function RecordPayment({
  onSubmit,
  busy,
}: {
  onSubmit: (b: { amountMinor: number; method: string; reference: string }) => void;
  busy: boolean;
}) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [reference, setReference] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = Number(amount.replace(/[,\s₹]/g, ""));
    if (!(r > 0) || reference.trim().length < 6) return;
    onSubmit({ amountMinor: rupeesToPaise(r), method, reference: reference.trim() });
  };
  return (
    <details>
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold">
        Record a payment
      </summary>
      <form onSubmit={submit} className="mt-2 grid gap-2">
        <Field
          label="Amount (₹)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <SelectField label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="CASH">Cash at the yard</option>
          <option value="CHEQUE">Cheque</option>
          <option value="BANK_TRANSFER">Bank transfer</option>
          <option value="UPI">UPI</option>
          <option value="OTHER">Other</option>
        </SelectField>
        <Field
          label="Receipt or reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          hint="Over ₹50,000 needs a second admin to verify."
        />
        <Button type="submit" loading={busy}>
          Record
        </Button>
      </form>
    </details>
  );
}

function Extend({
  onSubmit,
  busy,
}: {
  onSubmit: (b: { hours: number; reason: string }) => void;
  busy: boolean;
}) {
  const [hours, setHours] = useState("24");
  const [reason, setReason] = useState("");
  return (
    <details>
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold">
        Extend the deadline (once)
      </summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length >= 5) onSubmit({ hours: Number(hours), reason: reason.trim() });
        }}
        className="mt-2 grid gap-2"
      >
        <SelectField label="By" value={hours} onChange={(e) => setHours(e.target.value)}>
          {[6, 12, 24, 48, 72].map((h) => (
            <option key={h} value={h}>
              {h} hours
            </option>
          ))}
        </SelectField>
        <Field
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="e.g. bank holiday, payment gateway outage"
        />
        <Button type="submit" variant="outline" loading={busy}>
          Extend
        </Button>
      </form>
    </details>
  );
}

function Collect({ onSubmit, busy }: { onSubmit: (code: string) => void; busy: boolean }) {
  const [code, setCode] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim()) onSubmit(code.trim());
      }}
      className="grid gap-2"
    >
      <Field
        label="Gate-pass code from the buyer"
        value={code}
        autoComplete="off"
        onChange={(e) => setCode(e.target.value)}
      />
      <Button type="submit" loading={busy}>
        Mark collected
      </Button>
    </form>
  );
}

function Cancel({ onSubmit, busy }: { onSubmit: (reason: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <>
      <Button variant="ghost" className="text-danger" onClick={() => setOpen(true)}>
        Cancel the sale…
      </Button>
      <ConfirmDialog
        open={open}
        title="Cancel this sale?"
        confirmLabel="Cancel sale and refund"
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          if (reason.trim().length >= 5) {
            onSubmit(reason.trim());
            setOpen(false);
          }
        }}
      >
        <p className="mb-3 text-sm">
          Everything paid is refunded and the buyer's deposit is released. No forfeiture.
        </p>
        <TextAreaField
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="e.g. inspection report disputed"
        />
      </ConfirmDialog>
    </>
  );
}

function Reinstate({ userId }: { userId: string }) {
  const act = useAdminAction();
  return (
    <button
      type="button"
      className="font-semibold underline underline-offset-4"
      onClick={() =>
        act.mutate({
          path: `/bidders/${userId}/reinstate`,
          body: { reason: "Reviewed by an administrator" },
        })
      }
    >
      {act.isSuccess ? "Reinstated" : "Reinstate bidding"}
    </button>
  );
}

/* -------------------------------- deposits -------------------------------- */

const DEPOSIT_TABS = [
  { value: "PENDING", label: "To verify" },
  { value: "REFUND_REQUESTED", label: "Refunds requested" },
  { value: "HELD", label: "Held" },
  { value: "FORFEITED", label: "Forfeited" },
  { value: "all", label: "All" },
] as const;

export function AdminDepositsPage() {
  const [status, setStatus] = useState<(typeof DEPOSIT_TABS)[number]["value"]>("PENDING");
  const q = useQuery(adminDepositsQuery(status));
  const act = useAdminAction();
  return (
    <section className="mx-auto max-w-6xl px-4 pt-6 pb-14 sm:px-6">
      <AdminNav current="settlements" />
      <PageHeader
        className="mt-6"
        context={
          <Link to="/admin/settlements" className="font-semibold hover:underline">
            ← Settlements
          </Link>
        }
        title="Deposits"
        description="Refundable participation deposits. Verify a transfer against the bank account before marking it held."
      />
      <nav aria-label="Filter deposits" className="mt-6">
        <ul className={tabListClass}>
          {DEPOSIT_TABS.map((t) => (
            <li key={t.value} className="shrink-0">
              <button
                type="button"
                aria-pressed={status === t.value}
                className={tabClass(status === t.value)}
                onClick={() => setStatus(t.value)}
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {act.isError && <Alert className="mt-4">{settlementErrorMessage(act.error)}</Alert>}
      <div className="mt-4">
        {q.isPending ? (
          <Skeleton className="h-40 w-full rounded-xl" />
        ) : q.isError || !q.data ? (
          <LoadError title="Couldn't load deposits." onRetry={() => void q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState
            title="Nothing to show"
            body="Deposits buyers report appear here for verification."
          />
        ) : (
          <TableFrame label="Deposits">
            <table className={table}>
              <thead className={thead}>
                <tr>
                  <th scope="col" className={th}>
                    Buyer
                  </th>
                  <th scope="col" className={cn(th, num)}>
                    Amount
                  </th>
                  <th scope="col" className={th}>
                    Reference
                  </th>
                  <th scope="col" className={th}>
                    Status
                  </th>
                  <th scope="col" className={th}>
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((d) => (
                  <tr key={d.id} className={tr}>
                    <th scope="row" className={cn(td, "text-left font-semibold")}>
                      {d.user.name}
                      <span className="block text-xs font-normal text-steel">{d.user.email}</span>
                    </th>
                    <td className={cn(td, num)}>{formatINR(d.amountMinor)}</td>
                    <td className={td}>
                      <span className="font-mono">{d.reference}</span>
                      <span className="block text-xs text-steel">
                        {d.method.replace("_", " ").toLowerCase()} · {formatIST(d.createdAt)}
                      </span>
                    </td>
                    <td className={td}>{d.status.replace("_", " ").toLowerCase()}</td>
                    <td className={td}>
                      {d.status === "PENDING" && (
                        <span className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            onClick={() => act.mutate({ path: `/deposits/${d.id}/verify` })}
                          >
                            Verify
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              act.mutate({
                                path: `/deposits/${d.id}/reject`,
                                body: { reason: "Transfer not found on the account" },
                              })
                            }
                          >
                            Not received
                          </Button>
                        </span>
                      )}
                      {d.status === "REFUND_REQUESTED" && (
                        <Button
                          size="sm"
                          onClick={() => act.mutate({ path: `/deposits/${d.id}/refunded` })}
                        >
                          Mark refunded
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </div>
    </section>
  );
}
