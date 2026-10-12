import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorFields } from "../lib/logger";
import { AppError, problemBody, problemResponse } from "../lib/problem";
import type { AppEnv } from "../types";

export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get("requestId") ?? "unknown";
  if (err instanceof AppError) {
    return problemResponse(problemBody(err.code, requestId, err.message, err.extensions));
  }
  if (err instanceof HTTPException && err.status < 500) {
    return problemResponse(problemBody("VALIDATION_FAILED", requestId, err.message));
  }
  // Unexpected: log full detail, return a generic body (never leak internals).
  c.get("log")?.error("http.unhandled_error", errorFields(err));
  return problemResponse(problemBody("INTERNAL", requestId));
};

export const onNotFound: NotFoundHandler<AppEnv> = (c) =>
  problemResponse(problemBody("NOT_FOUND", c.get("requestId") ?? "unknown", "No such route"));
