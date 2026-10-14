import type { MyDeposit, MyPurchases, Settlement } from "@bike/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, LoadError } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { SelectField } from "@/components/ui/form";
import { Card, PageHeader, SuccessNote } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { duration, formatINR, formatIST, formatISTFull, rupeesToPaise } from "@/lib/format";
import { useServerNow } from "@/lib/server-time";
import { useMe } from "@/lib/session";
import {
  breakdown,
  depositQuery,
  needsAction,
  progressSteps,
  purchasesQuery,
  settlementErrorMessage,
  STATUS_LABEL,
  STATUS_TONE,
  useDepositAction,
  useOfferDecision,
  useReportPayment,
  type Tone,
} from "@/lib/settlement";
import { cn } from "@/lib/utils";

/** My purchases (docs/settlement.md): what you won, what's due and by when, and how to pay. */
export function PurchasesPage() {
  const me = useMe();
  const userId = me.data?.id ?? "-";
  const list = useQuery({ ...purchasesQuery(userId), enabled: Boolean(me.data) });
  const items = list.data?.items ?? [];
  const open = items.filter(
    (s) => !["COLLECTED", "CANCELLED", "DECLINED", "EXPIRED", "DEFAULTED"].includes(s.status),
  );
  const past = items.filter((s) => !open.includes(s));

  return (
    <section className="mx-auto max-w-4xl px-4 pt-8 pb-14 sm:px-6 sm:pt-10">
      <PageHeader
        title="My purchases"
        description="Auctions you won: pay 25% within 24 hours of the close and the balance within 15 days, then collect the bike."
        actions={
          <Button asChild variant="outline">
            <Link to="/me/deposit">Deposit and buying limit</Link>
          </Button>
        }
      />
      <div className="mt-6 space-y-5">
        {list.isPending ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : list.isError && !list.data ? (
          <LoadError title="Couldn't load your purchases." onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title="No purchases yet"
            body="When you win an auction it appears here, with what to pay, by when, and how."
            action={
              <Button asChild variant="secondary">
                <Link to="/auctions">Browse auctions</Link>
              </Button>
            }
          />
        ) : (
          <>
            {open.map((s) => (
              <PurchaseCard key={s.id} s={s} payTo={list.data?.payTo ?? null} userId={userId} />
            ))}
            {past.length > 0 && (
              <>
                <h2 className="pt-4 text-lg font-bold">Earlier</h2>
                {past.map((s) => (
                  <PurchaseCard key={s.id} s={s} payTo={list.data?.payTo ?? null} userId={userId} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

const toneClass: Record<Tone, string> = {
  action: "border-hivis/60 bg-hivis/12 text-asphalt",
  good: "border-ledger/40 bg-ledger/10 text-ledger",
  bad: "border-danger/40 bg-danger/8 text-danger",
  neutral: "border-rule bg-concrete text-steel",
};

function StatusChip({ s }: { s: Settlement }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold whitespace-nowrap",
        toneClass[STATUS_TONE[s.status]],
      )}
    >
      {STATUS_LABEL[s.status]}
    </span>
  );
}

function Progress({ s }: { s: Settlement }) {
  const steps = progressSteps(s);
  return (
    <ol className="mt-4 grid grid-cols-3 gap-2 text-xs" aria-label="Purchase progress">
      {steps.map((st) => (
        <li key={st.label} aria-current={st.state === "current" ? "step" : undefined}>
          <span
            className={cn(
              "block h-1.5 rounded-full",
              st.state === "done" ? "bg-ledger" : st.state === "current" ? "bg-hivis" : "bg-rule",
            )}
          />
          <span
            className={cn(
              "mt-1 block font-semibold",
              st.state === "todo" ? "text-steel" : "text-asphalt",
            )}
          >
            {st.state === "done" && <span className="sr-only">Done: </span>}
            {st.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function PurchaseCard({
  s,
  payTo,
  userId,
}: {
  s: Settlement;
  payTo: MyPurchases["payTo"];
  userId: string;
}) {
  const now = useServerNow();
  const headingId = useId();
  const owing = s.status === "AWAITING_INITIAL" || s.status === "AWAITING_BALANCE";
  return (
    <article
      aria-labelledby={headingId}
      className={cn(
        "rounded-xl border bg-paper p-4 shadow-card sm:p-6",
        needsAction(s) ? "border-hivis/60" : "border-rule",
      )}
    >
      <div className="flex gap-4">
        {s.coverUrl ? (
          <img
            src={s.coverUrl}
            alt=""
            className="hidden size-24 shrink-0 rounded-lg object-cover sm:block"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 id={headingId} className="text-lg font-bold">
              <Link
                to="/auctions/$auctionId"
                params={{ auctionId: s.auctionId }}
                className="hover:underline"
              >
                {s.title}
              </Link>
            </h2>
            <StatusChip s={s} />
          </div>
          <p className="mt-0.5 text-sm text-steel">
            {s.attempt > 1 ? "Second-chance offer" : "You won"} at {formatINR(s.priceMinor)}
          </p>
          {(owing || s.status === "PAID" || s.status === "COLLECTED") && <Progress s={s} />}
        </div>
      </div>

      {owing && s.dueBy !== null && (
        <div className="mt-5 rounded-lg border border-hivis/50 bg-hivis/10 p-4">
          {s.dueNowMinor > 0 ? (
            <>
              <p className="text-lg font-bold">
                Pay {formatINR(s.dueNowMinor)} by {formatIST(s.dueBy)}
              </p>
              <p className="mt-0.5 text-sm" title={formatISTFull(s.dueBy)}>
                {s.dueBy > now ? `${duration(s.dueBy - now)} left` : "The deadline has passed"}
                {s.status === "AWAITING_INITIAL"
                  ? " · first payment (25% of the price)"
                  : " · the balance"}
              </p>
            </>
          ) : (
            <p className="font-semibold">
              Your payments cover this stage; they're waiting to be verified.
            </p>
          )}
          {s.reportedMinor > 0 && (
            <p className="mt-2 text-sm font-semibold">
              {formatINR(s.reportedMinor)} reported, being verified (usually within 2 working
              hours).
            </p>
          )}
          <p className="mt-2 text-xs text-steel">
            Missing the deadline forfeits your deposit and the bike goes to the next bidder.
          </p>
        </div>
      )}

      {s.status === "OFFERED" && <OfferPanel s={s} userId={userId} />}

      {s.status === "PAID" && s.gatePass && (
        <div className="mt-5 rounded-lg border border-ledger/40 bg-ledger/10 p-4">
          <p className="font-bold">Paid in full. Collect within 7 days.</p>
          <p className="mt-1 text-sm">Show this gate-pass code at the yard with a photo ID:</p>
          <p
            className="mt-2 font-mono text-2xl font-bold tracking-[0.2em]"
            aria-label={`Gate pass ${s.gatePass.split("").join(" ")}`}
          >
            {s.gatePass}
          </p>
          <p className="mt-2 text-sm text-steel">
            Bring a photo ID. RC transfer (Forms 29 and 30) and any lender NOC are handled at
            collection.
          </p>
        </div>
      )}

      {(s.status === "DEFAULTED" ||
        s.status === "CANCELLED" ||
        s.status === "EXPIRED" ||
        s.status === "DECLINED") && (
        <div className="mt-5 rounded-lg border border-rule bg-concrete/60 p-4 text-sm">
          <p className="font-semibold">{s.closedReason}</p>
          {s.status === "DEFAULTED" && s.depositMinor > 0 && (
            <p className="mt-1">
              Your deposit of {formatINR(s.depositMinor)} was forfeited under the auction terms.
            </p>
          )}
          {s.refundDueMinor > 0 && (
            <p className="mt-1">
              {s.refundedAt
                ? `${formatINR(s.refundDueMinor)} was refunded.`
                : `${formatINR(s.refundDueMinor)} you paid will be refunded to the account it came from.`}
            </p>
          )}
        </div>
      )}

      {s.status !== "OFFERED" && (
        <details className="mt-4 group">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold underline-offset-4 hover:underline">
            Price breakdown and payments
          </summary>
          <dl className="mt-2 divide-y divide-rule rounded-lg border border-rule text-sm">
            {breakdown(s).map((r) => (
              <div key={r.label} className="flex justify-between gap-4 px-3 py-2">
                <dt className={r.strong ? "font-bold" : "text-steel"}>{r.label}</dt>
                <dd className={cn("tnum", r.strong && "font-bold")}>{r.value}</dd>
              </div>
            ))}
          </dl>
          {s.payments.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm" aria-label="Payments">
              {s.payments.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap justify-between gap-2 rounded-md bg-concrete/60 px-3 py-2"
                >
                  <span>
                    {formatINR(p.amountMinor)} ·{" "}
                    {p.method === "BANK_TRANSFER"
                      ? "Bank transfer"
                      : p.method === "UPI"
                        ? "UPI"
                        : p.method.toLowerCase()}{" "}
                    · ref {p.reference}
                  </span>
                  <span
                    className={cn(
                      "font-semibold",
                      p.status === "VERIFIED"
                        ? "text-ledger"
                        : p.status === "REJECTED"
                          ? "text-danger"
                          : "text-steel",
                    )}
                  >
                    {p.status === "VERIFIED"
                      ? "Verified"
                      : p.status === "REJECTED"
                        ? `Rejected${p.rejectReason ? `: ${p.rejectReason}` : ""}`
                        : "Being verified"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {owing && s.dueNowMinor - s.reportedMinor > 0 && (
        <ReportPayment s={s} payTo={payTo} userId={userId} />
      )}
    </article>
  );
}

function OfferPanel({ s, userId }: { s: Settlement; userId: string }) {
  const now = useServerNow();
  const decide = useOfferDecision(userId);
  const [confirm, setConfirm] = useState<"accept" | "decline" | null>(null);
  return (
    <div className="mt-5 rounded-lg border border-hivis/50 bg-hivis/10 p-4">
      <p className="text-lg font-bold">
        The winner didn't complete payment. You can buy it at your highest bid,{" "}
        {formatINR(s.priceMinor)}.
      </p>
      {s.offerExpiresAt && (
        <p className="mt-0.5 text-sm">
          Accept by {formatIST(s.offerExpiresAt)} (
          {s.offerExpiresAt > now ? `${duration(s.offerExpiresAt - now)} left` : "expired"}).
          Accepting starts the same rules: 25% within 24 hours, the balance within 15 days.
        </p>
      )}
      {decide.isError && <Alert className="mt-3">{settlementErrorMessage(decide.error)}</Alert>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => setConfirm("accept")}>Accept and buy</Button>
        <Button variant="outline" onClick={() => setConfirm("decline")}>
          Decline
        </Button>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === "accept"
            ? `Buy ${s.title} for ${formatINR(s.priceMinor)}?`
            : "Decline this offer?"
        }
        confirmLabel={confirm === "accept" ? "Accept and buy" : "Decline offer"}
        tone={confirm === "accept" ? "primary" : "danger"}
        busy={decide.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          decide.mutate({ id: s.id, decision: confirm! }, { onSettled: () => setConfirm(null) })
        }
      >
        {confirm === "accept"
          ? `You'll need to pay ${formatINR(s.initialDueMinor)} within 24 hours (less any deposit you hold).`
          : "The bike will be relisted. There's no penalty for declining."}
      </ConfirmDialog>
    </div>
  );
}

function ReportPayment({
  s,
  payTo,
  userId,
}: {
  s: Settlement;
  payTo: MyPurchases["payTo"];
  userId: string;
}) {
  const report = useReportPayment(userId);
  const suggested = Math.max(0, s.dueNowMinor - s.reportedMinor);
  const [amount, setAmount] = useState(String(suggested / 100));
  const [method, setMethod] = useState<"UPI" | "BANK_TRANSFER">("UPI");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | undefined>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const rupees = Number(amount.replace(/[,\s₹]/g, ""));
    if (!Number.isFinite(rupees) || rupees <= 0)
      return setError("Enter the amount you paid, in rupees.");
    if (!/^[A-Za-z0-9-]{6,40}$/.test(reference.trim()))
      return setError("Enter the transaction reference (UTR) from your bank or UPI app.");
    setError(undefined);
    report.mutate(
      { id: s.id, amountMinor: rupeesToPaise(rupees), method, reference: reference.trim() },
      { onSuccess: () => setReference("") },
    );
  };
  return (
    <Card
      as="div"
      title="Paid? Tell us"
      className="mt-5"
      description="Pay by UPI or bank transfer, then enter the reference so we can match it."
    >
      {payTo ? (
        <dl className="mb-4 grid gap-2 rounded-lg bg-concrete/60 p-3 text-sm sm:grid-cols-2">
          {payTo.upiId && (
            <div>
              <dt className="text-xs font-semibold text-steel">UPI ID</dt>
              <dd className="font-mono font-semibold break-all">{payTo.upiId}</dd>
            </div>
          )}
          {payTo.bankDetails && (
            <div>
              <dt className="text-xs font-semibold text-steel">Bank transfer</dt>
              <dd className="font-semibold whitespace-pre-line">{payTo.bankDetails}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="mb-4 rounded-lg bg-concrete/60 p-3 text-sm">
          Our team will share the account details for this payment with you.
        </p>
      )}
      <form onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Amount paid (₹)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <SelectField
          label="Method"
          value={method}
          onChange={(e) => setMethod(e.target.value as "UPI" | "BANK_TRANSFER")}
        >
          <option value="UPI">UPI</option>
          <option value="BANK_TRANSFER">Bank transfer (NEFT/IMPS/RTGS)</option>
        </SelectField>
        <Field
          label="Transaction reference (UTR)"
          value={reference}
          autoComplete="off"
          onChange={(e) => setReference(e.target.value)}
        />
        <div className="sm:col-span-3 flex flex-wrap items-center gap-3">
          <Button type="submit" loading={report.isPending}>
            Report payment
          </Button>
          {report.isSuccess && <SuccessNote>Reported. We'll verify it shortly.</SuccessNote>}
        </div>
      </form>
      {(error || report.isError) && (
        <Alert className="mt-3">{error ?? settlementErrorMessage(report.error)}</Alert>
      )}
    </Card>
  );
}

/** Deposit and buying limit (/me/deposit). */
export function DepositPage() {
  const me = useMe();
  const userId = me.data?.id ?? "-";
  const q = useQuery({ ...depositQuery(userId), enabled: Boolean(me.data) });
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8 pb-14 sm:px-6 sm:pt-10">
      <PageHeader
        context={
          <Link to="/me/purchases" className="font-semibold hover:underline">
            ← My purchases
          </Link>
        }
        title="Deposit and buying limit"
        description="A refundable participation deposit lets you bid up to 10× its value. It counts towards the price when you win."
      />
      <div className="mt-6 space-y-5">
        {q.isPending ? (
          <Skeleton className="h-48 w-full rounded-xl" />
        ) : q.isError || !q.data ? (
          <LoadError title="Couldn't load your deposit." onRetry={() => void q.refetch()} />
        ) : (
          <DepositBody d={q.data} userId={userId} />
        )}
      </div>
    </section>
  );
}

const DEPOSIT_STATUS: Record<string, string> = {
  PENDING: "Being verified",
  HELD: "Held",
  REJECTED: "Not received",
  APPLIED: "Counted towards a purchase",
  REFUND_REQUESTED: "Refund requested",
  REFUNDED: "Refunded",
  FORFEITED: "Forfeited",
};

function DepositBody({ d, userId }: { d: MyDeposit; userId: string }) {
  const act = useDepositAction(userId);
  const [tier, setTier] = useState(String(d.tiersMinor[1] ?? d.tiersMinor[0]));
  const [method, setMethod] = useState<"UPI" | "BANK_TRANSFER">("UPI");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | undefined>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^[A-Za-z0-9-]{6,40}$/.test(reference.trim()))
      return setError("Enter the transaction reference (UTR).");
    setError(undefined);
    act.mutate(
      { kind: "report", amountMinor: Number(tier), method, reference: reference.trim() },
      { onSuccess: () => setReference("") },
    );
  };
  return (
    <>
      {d.blockedReason && <Alert tone="caution">{d.blockedReason}</Alert>}
      <Card title="Your buying limit">
        <dl className="grid grid-cols-2 gap-4">
          <div>
            <dt className="text-xs font-semibold text-steel">Deposit held</dt>
            <dd className="font-expanded text-2xl font-extrabold tnum">{formatINR(d.heldMinor)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-steel">You can bid up to</dt>
            <dd className="font-expanded text-2xl font-extrabold tnum">
              {d.buyingLimitMinor === null ? "No limit" : formatINR(d.buyingLimitMinor)}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-steel">
          {d.required
            ? "A deposit is required to bid on this site."
            : "Deposits are optional on this site for now; once you hold one, your bids are limited to 10× its value."}
        </p>
        {d.heldMinor > 0 && (
          <div className="mt-4">
            <Button
              variant="outline"
              loading={act.isPending}
              onClick={() => act.mutate({ kind: "refund" })}
            >
              Ask for my deposit back
            </Button>
          </div>
        )}
      </Card>
      <Card
        title="Add a deposit"
        description="Transfer one of these amounts by UPI or bank transfer, then enter its reference. We verify it within 2 working hours."
      >
        <form onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-3">
          <SelectField label="Amount" value={tier} onChange={(e) => setTier(e.target.value)}>
            {d.tiersMinor.map((t) => (
              <option key={t} value={t}>
                {formatINR(t)} (bid up to {formatINR(t * d.multiple)})
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Method"
            value={method}
            onChange={(e) => setMethod(e.target.value as "UPI" | "BANK_TRANSFER")}
          >
            <option value="UPI">UPI</option>
            <option value="BANK_TRANSFER">Bank transfer</option>
          </SelectField>
          <Field
            label="Transaction reference (UTR)"
            value={reference}
            autoComplete="off"
            onChange={(e) => setReference(e.target.value)}
          />
          <div className="sm:col-span-3">
            <Button type="submit" loading={act.isPending && act.variables?.kind === "report"}>
              Report deposit
            </Button>
          </div>
        </form>
        {(error || act.isError) && (
          <Alert className="mt-3">{error ?? settlementErrorMessage(act.error)}</Alert>
        )}
      </Card>
      {d.deposits.length > 0 && (
        <Card title="History">
          <ul className="divide-y divide-rule text-sm">
            {d.deposits.map((x) => (
              <li key={x.id} className="flex flex-wrap justify-between gap-2 py-2.5">
                <span>
                  {formatINR(x.amountMinor)} · ref {x.reference}
                  <span className="block text-xs text-steel">{formatIST(x.createdAt)}</span>
                </span>
                <span className="font-semibold">{DEPOSIT_STATUS[x.status] ?? x.status}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
