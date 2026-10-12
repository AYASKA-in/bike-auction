import { z } from "zod";

/**
 * Stable, machine-readable error codes. Clients branch on `code`, never on English text.
 * Adding a code is backwards compatible; renaming or removing one is a breaking change.
 */
export const ErrorCode = z.enum([
  "AUTH_REQUIRED",
  "INVALID_CREDENTIALS",
  "ACCOUNT_EXISTS",
  "WEAK_PASSWORD",
  "CAPTCHA_FAILED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "AUCTION_NOT_LIVE",
  "AUCTION_ENDED",
  "AUCTION_CANCELLED",
  "BID_TOO_LOW",
  "BID_UNREASONABLE",
  "BID_INVALID_AMOUNT",
  "ALREADY_LEADING",
  "INVALID_TRANSITION",
  "IDEMPOTENCY_KEY_REUSED",
  "RATE_LIMITED",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "SERVICE_UNAVAILABLE",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** RFC 9457 Problem Details with a `code` and `requestId` extension. */
export const ProblemDetails = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    code: ErrorCode,
    detail: z.string().optional(),
    requestId: z.string(),
  })
  .catchall(z.unknown());
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const PROBLEM_CONTENT_TYPE = "application/problem+json";
