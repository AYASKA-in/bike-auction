import { ProblemDetails, type ErrorCode } from "@bike/contracts";

/** Typed API error. UI copy is chosen by `code`, never by parsing server English. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "NETWORK",
    readonly detail?: string,
    readonly requestId?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(detail ?? code);
  }
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
): Promise<T> {
  return request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    parse,
  );
}
