import { ProblemDetails, type ErrorCode } from "@bike/contracts";

/** Typed API error. UI copy is chosen by `code`, never by parsing server English. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "NETWORK",
    readonly detail?: string,
    readonly requestId?: string,
    readonly retryAfterSeconds?: number,
    /** RFC 9457 extension members (e.g. `minNextBidMinor` on BID_TOO_LOW). Untrusted: validate. */
    readonly extensions?: Readonly<Record<string, unknown>>,
  ) {
    super(detail ?? code);
  }
}

/** Problem members beyond the standard ones (type, title, status, code, detail, requestId). */
function problemExtensions(p: ProblemDetails): Record<string, unknown> {
  const { type: _t, title: _ti, status: _s, code: _c, detail: _d, requestId: _r, ...rest } = p;
  return rest;
}

async function request<T>(path: string, init: RequestInit, parse: (x: unknown) => T): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiError(0, "NETWORK");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const problem = ProblemDetails.safeParse(body);
    const retry = Number(res.headers.get("retry-after"));
    throw new ApiError(
      res.status,
      problem.success ? problem.data.code : "INTERNAL",
      problem.success ? problem.data.detail : undefined,
      problem.success ? problem.data.requestId : undefined,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
      problem.success ? problemExtensions(problem.data) : undefined,
    );
  }
  return parse(body);
}

export function apiGet<T>(
  path: string,
  parse: (x: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  return request(path, { signal: signal ?? null }, parse);
}

export function apiPost<T>(
  path: string,
  body: unknown,
  parse: (x: unknown) => T,
  headers: Record<string, string> = {},
  timeoutMs?: number,
): Promise<T> {
  return request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      // A timed-out request is reported as NETWORK (outcome unknown), never as a rejection.
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    },
    parse,
  );
}

export function apiSend<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  parse: (x: unknown) => T,
  /** Extra headers (e.g. Idempotency-Key). */
  headers: Record<string, string> = {},
  /** A timed-out request is reported as NETWORK (outcome unknown), never as a rejection. */
  timeoutMs?: number,
): Promise<T> {
  return request(
    path,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    },
    parse,
  );
}

/** Raw binary upload (images). */
export function apiUpload<T>(path: string, blob: Blob, parse: (x: unknown) => T): Promise<T> {
  return request(
    path,
    { method: "POST", headers: { "content-type": blob.type }, body: blob },
    parse,
  );
}
