import { z } from "zod";

/**
 * Post-auction settlement, payments and participation deposits (docs/settlement.md).
 * Objects are STRICT: an unexpected field (another buyer's id, a bank account number) fails parsing.
 */

export const SettlementStatus = z.enum([
  "OFFERED",
  "AWAITING_INITIAL",
  "AWAITING_BALANCE",
  "PAID",
  "COLLECTED",
  "DEFAULTED",
  "CANCELLED",
  "DECLINED",
  "EXPIRED",
]);
export type SettlementStatus = z.infer<typeof SettlementStatus>;

export const PaymentMethod = z.enum(["UPI", "BANK_TRANSFER", "CASH", "CHEQUE", "OTHER"]);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const PaymentStatus = z.enum(["REPORTED", "VERIFIED", "REJECTED"]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const DepositStatus = z.enum([
  "PENDING",
  "HELD",
  "REJECTED",
  "APPLIED",
  "REFUND_REQUESTED",
  "REFUNDED",
  "FORFEITED",
]);
export type DepositStatus = z.infer<typeof DepositStatus>;

/** A bank/UPI transaction reference (UTR is 12–22 characters; cheque numbers are shorter). */
export const PaymentReference = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{6,40}$/, "Enter the transaction reference (UTR): 6–40 letters or digits");

export const Payment = z.strictObject({
  id: z.string(),
  amountMinor: z.number().int().positive(),
  method: PaymentMethod,
  reference: z.string(),
  status: PaymentStatus,
  reportedAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
  rejectReason: z.string().nullable(),
  /** True when an admin recorded it (cash at the yard, a cheque). */
  recordedByAdmin: z.boolean(),
});
export type Payment = z.infer<typeof Payment>;

export const Settlement = z.strictObject({
  id: z.string(),
  auctionId: z.string(),
  attempt: z.number().int().positive(),
  title: z.string(),
  bikeId: z.string(),
  coverUrl: z.string().nullable(),
  status: SettlementStatus,
  priceMinor: z.number().int().positive(),
  feeMinor: z.number().int().nonnegative(),
  gstMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().positive(),
  depositMinor: z.number().int().nonnegative(),
  initialDueMinor: z.number().int().nonnegative(),
  payableMinor: z.number().int().nonnegative(),
  paidMinor: z.number().int().nonnegative(),
  reportedMinor: z.number().int().nonnegative(),
  /** What must be paid next and by when (0 / null when nothing is due). */
  dueNowMinor: z.number().int().nonnegative(),
  dueBy: z.number().int().nullable(),
  startAt: z.number().int(),
  initialDeadline: z.number().int().nullable(),
  balanceDeadline: z.number().int().nullable(),
  offerExpiresAt: z.number().int().nullable(),
  extensionMs: z.number().int().nonnegative(),
  /** Shown to the buyer once paid in full; checked by the yard at collection. */
  gatePass: z.string().nullable(),
  refundDueMinor: z.number().int().nonnegative(),
  refundedAt: z.number().int().nullable(),
  closedReason: z.string().nullable(),
  nextStep: z.enum(["RUNNER_UP_OFFERED", "RELISTED"]).nullable(),
  updatedAt: z.number().int(),
  payments: z.array(Payment),
});
export type Settlement = z.infer<typeof Settlement>;

export const MyPurchases = z.strictObject({
  items: z.array(Settlement),
  /** Where to pay; null until the operator configures it (never invented). */
  payTo: z
    .strictObject({ upiId: z.string().nullable(), bankDetails: z.string().nullable() })
    .nullable(),
});
export type MyPurchases = z.infer<typeof MyPurchases>;

export const ReportPaymentBody = z.strictObject({
  amountMinor: z.number().int().positive().max(1_000_000_000),
  method: z.enum(["UPI", "BANK_TRANSFER"]),
  reference: PaymentReference,
});
export type ReportPaymentBody = z.infer<typeof ReportPaymentBody>;

export const Deposit = z.strictObject({
  id: z.string(),
  amountMinor: z.number().int().positive(),
  method: PaymentMethod,
  reference: z.string(),
  status: DepositStatus,
  note: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Deposit = z.infer<typeof Deposit>;

export const MyDeposit = z.strictObject({
  /** Whether this deployment requires a deposit to bid. */
  required: z.boolean(),
  heldMinor: z.number().int().nonnegative(),
  /** null = no limit (deposits not required and none held). */
  buyingLimitMinor: z.number().int().nonnegative().nullable(),
  tiersMinor: z.array(z.number().int().positive()),
  multiple: z.number().int().positive(),
  deposits: z.array(Deposit),
  canBid: z.boolean(),
  /** Why bidding is paused, in plain words (null when it isn't). */
  blockedReason: z.string().nullable(),
});
export type MyDeposit = z.infer<typeof MyDeposit>;

export const ReportDepositBody = z.strictObject({
  amountMinor: z.number().int().positive(),
  method: z.enum(["UPI", "BANK_TRANSFER"]),
  reference: PaymentReference,
});
export type ReportDepositBody = z.infer<typeof ReportDepositBody>;

/** Admin views add the buyer's identity (admins only). */
export const AdminSettlement = Settlement.extend({
  buyer: z.strictObject({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    defaults: z.number().int().nonnegative(),
    suspended: z.boolean(),
  }),
  pendingReports: z.number().int().nonnegative(),
});
export type AdminSettlement = z.infer<typeof AdminSettlement>;

export const AdminSettlementList = z.strictObject({
  items: z.array(AdminSettlement),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type AdminSettlementList = z.infer<typeof AdminSettlementList>;

export const AdminDeposit = Deposit.extend({
  user: z.strictObject({ id: z.string(), name: z.string(), email: z.string() }),
});
export type AdminDeposit = z.infer<typeof AdminDeposit>;

export const RecordPaymentBody = z.strictObject({
  amountMinor: z.number().int().positive().max(1_000_000_000),
  method: PaymentMethod,
  reference: PaymentReference,
});
export type RecordPaymentBody = z.infer<typeof RecordPaymentBody>;

export const ReasonBody = z.strictObject({ reason: z.string().trim().min(5).max(300) });
export const ExtendBody = z.strictObject({
  hours: z.number().int().min(1).max(72),
  reason: z.string().trim().min(5).max(300),
});
export const CollectBody = z.strictObject({ gatePass: z.string().trim().min(6).max(12) });
