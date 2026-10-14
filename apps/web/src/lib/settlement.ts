import {
  AdminDeposit,
  AdminSettlement,
  AdminSettlementList,
  MyDeposit,
  MyPurchases,
  Settlement,
  type SettlementStatus,
} from "@bike/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ApiError, apiGet, apiSend } from "./api";
import { formatINR } from "./format";

/** Buyer- and admin-side settlement data (docs/settlement.md). */

export const purchasesKey = (userId: string) => ["mine", userId, "purchases"] as const;

export const purchasesQuery = (userId: string) =>
  queryOptions({
    queryKey: purchasesKey(userId),
    queryFn: ({ signal }) => apiGet("/me/purchases", (x) => MyPurchases.parse(x), signal),
    // Deadlines are hours away; a minute is plenty, plus focus/reconnect.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

export const depositQuery = (userId: string) =>
  queryOptions({
    queryKey: ["mine", userId, "deposit"],
    queryFn: ({ signal }) => apiGet("/me/deposit", (x) => MyDeposit.parse(x), signal),
  });

/** What the buyer must do, in one line (the status chip and the header badge use it). */
export const STATUS_LABEL: Record<SettlementStatus, string> = {
  OFFERED: "Offer waiting for you",
  AWAITING_INITIAL: "Pay 25%",
  AWAITING_BALANCE: "Pay the balance",
  PAID: "Paid — ready to collect",
  COLLECTED: "Collected",
  DEFAULTED: "Payment missed",
  CANCELLED: "Cancelled",
  DECLINED: "Offer declined",
  EXPIRED: "Offer expired",
};

export type Tone = "action" | "good" | "bad" | "neutral";
export const STATUS_TONE: Record<SettlementStatus, Tone> = {
  OFFERED: "action",
  AWAITING_INITIAL: "action",
  AWAITING_BALANCE: "action",
  PAID: "good",
  COLLECTED: "good",
  DEFAULTED: "bad",
  CANCELLED: "neutral",
  DECLINED: "neutral",
  EXPIRED: "neutral",
};

/** Purchases that need the buyer to act now (pay, accept an offer). */
export const needsAction = (s: Settlement) =>
  s.status === "OFFERED" ||
  ((s.status === "AWAITING_INITIAL" || s.status === "AWAITING_BALANCE") && s.dueNowMinor > 0);

/** Steps of the progress line: Initial 25% → Balance → Collect. */
export function progressSteps(
  s: Settlement,
): { label: string; state: "done" | "current" | "todo" }[] {
  const order = ["AWAITING_INITIAL", "AWAITING_BALANCE", "PAID", "COLLECTED"];
  const at = order.indexOf(s.status);
  const labels = ["Pay 25%", "Pay the balance", "Collect the bike"];
  return labels.map((label, i) => ({
    label,
    state: at === -1 ? "todo" : i < at ? "done" : i === at ? "current" : "todo",
  }));
}

/** Plain-words payment breakdown for the card. */
export function breakdown(s: Settlement): { label: string; value: string; strong?: boolean }[] {
  return [
    { label: "Winning bid", value: formatINR(s.priceMinor) },
    { label: "Buyer fee (2%)", value: formatINR(s.feeMinor) },
    { label: "GST on the fee (18%)", value: formatINR(s.gstMinor) },
    { label: "Total", value: formatINR(s.totalMinor), strong: true },
    ...(s.depositMinor > 0
      ? [{ label: "Your deposit, counted", value: `− ${formatINR(s.depositMinor)}` }]
      : []),
    { label: "Paid and verified", value: `− ${formatINR(s.paidMinor)}` },
  ];
}

export function settlementErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "NETWORK")
      return "You're offline or the connection dropped. Nothing was sent; try again.";
    if (e.detail) return e.detail;
  }
  return "Something went wrong. Try again.";
}

const ItemBody = z.object({ item: Settlement }).transform((x) => x.item);

export function useReportPayment(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      amountMinor: number;
      method: "UPI" | "BANK_TRANSFER";
      reference: string;
    }) =>
      apiSend(
        "POST",
        `/me/purchases/${v.id}/payments`,
        {
          amountMinor: v.amountMinor,
          method: v.method,
          reference: v.reference,
        },
        (x) => ItemBody.parse(x),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: purchasesKey(userId) }),
  });
}

export function useOfferDecision(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; decision: "accept" | "decline" }) =>
      apiSend("POST", `/me/purchases/${v.id}/${v.decision}`, undefined, (x) => x),
    onSettled: () => qc.invalidateQueries({ queryKey: ["mine", userId] }),
  });
}

export function useDepositAction(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      v:
        | {
            kind: "report";
            amountMinor: number;
            method: "UPI" | "BANK_TRANSFER";
            reference: string;
          }
        | { kind: "refund" },
    ) =>
      v.kind === "report"
        ? apiSend(
            "POST",
            "/me/deposit",
            { amountMinor: v.amountMinor, method: v.method, reference: v.reference },
            (x) => MyDeposit.parse(x),
          )
        : apiSend("POST", "/me/deposit/refund", undefined, (x) => MyDeposit.parse(x)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["mine", userId] }),
  });
}

/* --------------------------------- admin --------------------------------- */

export const ADMIN_FILTERS = [
  { value: "open", label: "Open" },
  { value: "awaiting_verification", label: "To verify" },
  { value: "overdue_soon", label: "Due within 24 h" },
  { value: "paid", label: "Ready to collect" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
] as const;
export type AdminFilter = (typeof ADMIN_FILTERS)[number]["value"];

export const adminSettlementsQuery = (filter: AdminFilter) =>
  queryOptions({
    queryKey: ["admin", "settlements", filter],
    queryFn: ({ signal }) =>
      apiGet(`/admin/settlements?status=${filter}`, (x) => AdminSettlementList.parse(x), signal),
    refetchInterval: 60_000,
  });

const TimelineEntry = z.object({
  action: z.string(),
  metadata: z.string().nullable(),
  at: z.number(),
  actor: z.string().nullable(),
});
export const AdminSettlementDetail = z.object({
  item: AdminSettlement,
  timeline: z.array(TimelineEntry),
});
export type AdminSettlementDetail = z.infer<typeof AdminSettlementDetail>;

export const adminSettlementQuery = (id: string) =>
  queryOptions({
    queryKey: ["admin", "settlement", id],
    queryFn: ({ signal }) =>
      apiGet(`/admin/settlements/${id}`, (x) => AdminSettlementDetail.parse(x), signal),
  });

export const adminDepositsQuery = (status: string) =>
  queryOptions({
    queryKey: ["admin", "deposits", status],
    queryFn: ({ signal }) =>
      apiGet(
        `/admin/deposits?status=${status}`,
        (x) => z.object({ items: z.array(AdminDeposit) }).parse(x),
        signal,
      ),
  });

/** Any admin settlement/deposit action; refreshes every admin settlement view afterwards. */
export function useAdminAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { path: string; body?: unknown }) =>
      apiSend("POST", `/admin${v.path}`, v.body, (x) => x),
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin"] }),
  });
}

export const AUDIT_LABEL: Record<string, string> = {
  PAYMENT_REPORTED: "Buyer reported a payment",
  PAYMENT_VERIFIED: "Payment verified",
  PAYMENT_REJECTED: "Payment rejected",
  PAYMENT_RECORDED: "Payment recorded by an admin",
  SETTLEMENT_EXTENDED: "Deadline extended",
  SETTLEMENT_COLLECTED: "Bike collected",
  SETTLEMENT_CANCELLED: "Sale cancelled",
  RUNNER_UP_OFFERED: "Offered to the runner-up",
  SETTLEMENT_RELISTED: "Marked for relisting",
  SETTLEMENT_REFUNDED: "Refund paid",
  OFFER_ACCEPTED: "Offer accepted",
  OFFER_DECLINED: "Offer declined",
};
