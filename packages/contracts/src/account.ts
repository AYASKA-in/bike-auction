import { z } from "zod";
import { Role } from "./auth";

/**
 * Account self-service and data-protection contracts (DPDP Act 2023 / DPDP Rules 2025).
 * See docs/privacy.md. All response objects are STRICT so a leaked field (password hash, session
 * token, another user's id, an HMAC) is a parse failure in tests, not a silent bug.
 */

/** Bump when the Privacy Notice text changes materially; sign-up must echo the current version. */
export const PRIVACY_NOTICE_VERSION = "2026-10-13";

/** The only consent purpose we ask for: running the account and the auctions it takes part in. */
export const ConsentPurpose = z.enum(["ACCOUNT_AND_BIDDING"]);
export type ConsentPurpose = z.infer<typeof ConsentPurpose>;

/**
 * Sent with sign-up (`POST /api/v1/auth/sign-up/email`, field `consent`). The server refuses
 * sign-up without it and records one `consents` row per purpose.
 */
export const SignUpConsent = z.strictObject({
  accepted: z.literal(true, { error: "Agree to the Privacy Notice and Terms to continue" }),
  version: z.literal(PRIVACY_NOTICE_VERSION, {
    error: "The Privacy Notice has changed. Reload the page and review it.",
  }),
});
export type SignUpConsent = z.infer<typeof SignUpConsent>;

export const CURRENT_SIGN_UP_CONSENT: SignUpConsent = {
  accepted: true,
  version: PRIVACY_NOTICE_VERSION,
};

const Ms = z.number().int().nonnegative();

export const ConsentRecord = z.strictObject({
  purpose: ConsentPurpose,
  version: z.string(),
  at: Ms,
});
export type ConsentRecord = z.infer<typeof ConsentRecord>;

/** `GET /api/v1/me/account`: profile basics for the account page. */
export const AccountSummary = z.strictObject({
  name: z.string(),
  email: z.string(),
  role: Role,
  createdAt: Ms,
  consents: z.array(ConsentRecord),
  noticeVersion: z.string(),
});
export type AccountSummary = z.infer<typeof AccountSummary>;

/** `GET /api/v1/me/export`: a machine-readable copy of the caller's personal data. */
export const AccountExport = z.strictObject({
  format: z.literal("bike-auction.account-export.v1"),
  generatedAt: z.string(),
  noticeVersion: z.string(),
  account: z.strictObject({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    role: Role,
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  /** Active sign-ins (never the session token). */
  sessions: z.array(
    z.strictObject({
      createdAt: z.string(),
      expiresAt: z.string(),
      ipAddress: z.string().nullable(),
      userAgent: z.string().nullable(),
    }),
  ),
  consents: z.array(ConsentRecord),
  watchlist: z.array(
    z.strictObject({ auctionId: z.string(), title: z.string().nullable(), watchedAt: Ms }),
  ),
  /** One row per auction you bid in (from the "My bids" read model). */
  bids: z.array(
    z.strictObject({
      auctionId: z.string(),
      title: z.string().nullable(),
      myHighestMinor: z.number().int().positive(),
      updatedAt: Ms,
      auctionStatus: z.string().nullable(),
      outcome: z.string().nullable(),
      youWon: z.boolean(),
    }),
  ),
  /**
   * Your OWN hidden maximum bids (proxy bidding), read from each auction's authoritative object via
   * the owner-only view; only auctions you bid in are asked. Other buyers' maxima never appear.
   */
  maxBids: z.array(
    z.strictObject({
      auctionId: z.string(),
      title: z.string().nullable(),
      maxMinor: z.number().int().positive(),
      auctionStatus: z.string(),
      youAreLeading: z.boolean(),
    }),
  ),
  /** Purchases you won (or were offered) and their payments. */
  purchases: z.array(
    z.strictObject({
      settlementId: z.string(),
      auctionId: z.string(),
      title: z.string(),
      status: z.string(),
      priceMinor: z.number().int().positive(),
      payments: z.array(
        z.strictObject({
          amountMinor: z.number().int().positive(),
          method: z.string(),
          reference: z.string(),
          status: z.string(),
          reportedAt: Ms,
        }),
      ),
    }),
  ),
  /** Participation deposits. */
  deposits: z.array(
    z.strictObject({
      amountMinor: z.number().int().positive(),
      method: z.string(),
      reference: z.string(),
      status: z.string(),
      createdAt: Ms,
    }),
  ),
  /** Security log entries linked to your account (identifiers are not included). */
  securityEvents: z.array(z.strictObject({ type: z.string(), at: Ms, requestId: z.string() })),
  /** What is NOT in this file and why (DPDP transparency). */
  notes: z.array(z.string()),
});
export type AccountExport = z.infer<typeof AccountExport>;

/** `DELETE /api/v1/me` body: re-type your email to confirm. */
export const DeleteAccountInput = z.strictObject({
  confirmEmail: z.string().trim().min(3).max(254),
});
export type DeleteAccountInput = z.infer<typeof DeleteAccountInput>;

export const DeleteAccountResult = z.strictObject({ deleted: z.literal(true), deletedAt: Ms });
export type DeleteAccountResult = z.infer<typeof DeleteAccountResult>;

/** Why an account can't be deleted yet (409 CONFLICT extension `blockers`). */
export const DeletionBlocker = z.strictObject({
  auctionId: z.string(),
  title: z.string().nullable(),
  reason: z.enum(["LEADING_LIVE_AUCTION", "ACTIVE_MAX_BID_LIVE_AUCTION", "WON_UNSETTLED_AUCTION"]),
});
export type DeletionBlocker = z.infer<typeof DeletionBlocker>;

/** A won auction counts as "unsettled" for this long after it closes (offline settlement window). */
export const SETTLEMENT_WINDOW_DAYS = 30;
