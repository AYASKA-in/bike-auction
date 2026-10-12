import { PROBLEM_CONTENT_TYPE, type ErrorCode, type ProblemDetails } from "@bike/contracts";

const TITLES: Record<ErrorCode, [status: number, title: string]> = {
  AUTH_REQUIRED: [401, "Authentication required"],
  INVALID_CREDENTIALS: [401, "Email or password is incorrect"],
  ACCOUNT_EXISTS: [409, "An account with this email already exists"],
  WEAK_PASSWORD: [422, "Password does not meet the policy"],
  CAPTCHA_FAILED: [400, "Bot check failed"],
  FORBIDDEN: [403, "Forbidden"],
  VALIDATION_FAILED: [422, "Validation failed"],
  NOT_FOUND: [404, "Not found"],
  AUCTION_NOT_LIVE: [409, "Auction is not live"],
  AUCTION_ENDED: [409, "Auction has ended"],
  AUCTION_CANCELLED: [409, "Auction was cancelled"],
  BID_TOO_LOW: [409, "Bid too low"],
  BID_UNREASONABLE: [422, "Bid amount unreasonable"],
  IDEMPOTENCY_KEY_REUSED: [422, "Idempotency key reused with a different request"],
  RATE_LIMITED: [429, "Too many requests"],
  CONFLICT: [409, "Conflict"],
  INTERNAL: [500, "Internal error"],
};

/** A domain/HTTP error that maps 1:1 onto an RFC 9457 problem response. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    detail?: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail ?? TITLES[code][1]);
    this.status = TITLES[code][0];
  }
}

export function problemBody(
  code: ErrorCode,
  requestId: string,
  detail?: string,
  extensions: Record<string, unknown> = {},
): ProblemDetails {
  const [status, title] = TITLES[code];
  return {
    ...extensions,
    type: `https://bike-auction.dev/errors/${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
    requestId,
  };
}

export function problemResponse(body: ProblemDetails, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { "content-type": PROBLEM_CONTENT_TYPE, ...headers },
  });
}
