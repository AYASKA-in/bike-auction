import {
  AccountSummary,
  DeleteAccountResult,
  DeletionBlocker,
  PRIVACY_NOTICE_VERSION,
  SETTLEMENT_WINDOW_DAYS,
} from "@bike/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiGet, apiSend } from "./api";

/**
 * Account self-service (Day 8): profile basics, data export, account deletion. The server is the
 * authority for every rule here (routes/account.ts); this module only presents its answers.
 */

export const accountQuery = (userId: string) =>
  queryOptions({
    queryKey: ["account", userId],
    queryFn: ({ signal }) => apiGet("/me/account", (x) => AccountSummary.parse(x), signal),
    staleTime: 60_000,
  });

/** `bike-auction-data-2026-10-13.json` from the server's Content-Disposition, with a safe fallback. */
export function exportFilename(contentDisposition: string | null, now = new Date()): string {
  const m = /filename="([\w.-]{1,80})"/.exec(contentDisposition ?? "");
  return m?.[1] ?? `bike-auction-data-${now.toISOString().slice(0, 10)}.json`;
}

/** Downloads GET /me/export as a file (cookie-authenticated, so a plain link would also work). */
export async function downloadMyData(): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/v1/me/export", { credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "NETWORK");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      code?: ApiError["code"];
      detail?: string;
      requestId?: string;
    } | null;
    const retry = Number(res.headers.get("retry-after"));
    throw new ApiError(
      res.status,
      body?.code ?? "INTERNAL",
      body?.detail,
      body?.requestId,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(res.headers.get("content-disposition"));
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** The re-typed confirmation must match the account email (case-insensitive, trimmed). */
export function confirmationMatches(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase() && email.length > 0;
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (confirmEmail: string) =>
      apiSend("DELETE", "/me", { confirmEmail }, (x) => DeleteAccountResult.parse(x)),
    onSuccess: () => {
      // Every cached personal query belongs to an account that no longer exists.
      qc.clear();
      qc.setQueryData(["me"], null);
    },
  });
}

/** Blockers from a 409 (untrusted extension: validated, unknown shapes ignored). */
export function deletionBlockers(err: unknown): DeletionBlocker[] {
  if (!(err instanceof ApiError) || err.code !== "CONFLICT") return [];
  const parsed = DeletionBlocker.array().safeParse(err.extensions?.blockers);
  return parsed.success ? parsed.data : [];
}

export function blockerLabel(b: DeletionBlocker): string {
  switch (b.reason) {
    case "LEADING_LIVE_AUCTION":
      return "You have the highest bid in this live auction.";
    case "ACTIVE_MAX_BID_LIVE_AUCTION":
      return "Your maximum bid can still bid for you in this live auction.";
    case "WON_UNSETTLED_AUCTION":
      return `You won this auction less than ${SETTLEMENT_WINDOW_DAYS} days ago.`;
  }
}

export function accountErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  switch (err.code) {
    case "RATE_LIMITED":
      return "Too many requests. Wait a minute and try again.";
    case "AUTH_REQUIRED":
      return "Your session has ended. Sign in again.";
    case "NETWORK":
      return "Can't reach the server. Check your connection and try again.";
    case "CONFLICT":
    case "FORBIDDEN":
    case "VALIDATION_FAILED":
    case "SERVICE_UNAVAILABLE":
      return err.detail ?? "That didn't work. Try again.";
    default:
      return `Something went wrong on our side${err.requestId ? ` (reference ${err.requestId})` : ""}. Try again.`;
  }
}

/**
 * Plain-language Privacy Notice (DPDP Act 2023 §5 / DPDP Rules 2025): what, why, how long, rights.
 * Shown at /privacy and summarised at sign-up. Version = PRIVACY_NOTICE_VERSION (recorded with
 * consent). Full engineering detail: docs/privacy.md. Prototype text: not reviewed by a lawyer.
 */
export const NOTICE_VERSION = PRIVACY_NOTICE_VERSION;

export const NOTICE_PURPOSES: { title: string; body: string }[] = [
  {
    title: "Run your account",
    body: "Your name and email identify you and let you sign in. Your password is stored only as a salted hash.",
  },
  {
    title: "Run the auctions you join",
    body: "Your bids, any maximum bid you set and the result are recorded so every auction has one fair, verifiable order. Other bidders only ever see a per-auction code such as “Bidder K7Q2”.",
  },
  {
    title: "Keep the service safe",
    body: "Sign-in attempts and security events are logged with keyed hashes of your email and IP address to detect abuse, and kept for one year.",
  },
];

export const NOTICE_RETENTION: { what: string; howLong: string }[] = [
  { what: "Account (name, email, password hash)", howLong: "Until you delete your account" },
  { what: "Sign-in sessions", howLong: "7 days, removed daily after they expire" },
  { what: "Watchlist", howLong: "Until you remove it; 90 days after an auction ends" },
  { what: "Security logs", howLong: "1 year" },
  {
    what: "Auction bid records (pseudonymous)",
    howLong: "Kept as the auction's record, also after you delete your account",
  },
];
