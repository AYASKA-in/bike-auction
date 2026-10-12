import { ProblemDetails, type ErrorCode } from "@bike/contracts";

/** Typed API error. UI copy is chosen by `code`, never by parsing server English. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "NETWORK",
    readonly requestId?: string,
  ) {
    super(code);
  }
}

export async function apiGet<T>(
  path: string,
  parse: (x: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { signal: signal ?? null, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "NETWORK");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const problem = ProblemDetails.safeParse(body);
    throw new ApiError(
      res.status,
      problem.success ? problem.data.code : "INTERNAL",
      problem.data?.requestId,
    );
  }
  return parse(body);
}
