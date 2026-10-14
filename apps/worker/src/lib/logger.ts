/**
 * Structured JSON logger. Workers Logs indexes JSON fields, so every line is one object:
 *
 *   { ts, level, event, requestId?, route?, status?, durationMs?, colo?, auctionId?, ...fields }
 *
 * Privacy (BLUEPRINT §8, §10): before anything reaches the log pipeline, values under sensitive
 * keys are replaced with "[REDACTED]" at any depth, and e-mail addresses inside free-text strings
 * (e.g. error messages) are masked. Sensitive = credentials, cookies, sessions, e-mails, client
 * IPs, reserve amounts and hidden maximum bids. Callers should still not pass such data: redaction
 * is the safety net, not the design.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

/** Any key matching this (case-insensitive, anywhere in the key) is redacted. */
export const SENSITIVE_KEY =
  /pass|token|cookie|secret|authorization|email|reserve|max|session|^ip$|ipaddress|clientip|connecting-ip|forwarded|real-ip/i;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAX_DEPTH = 6;
export const REDACTED = "[REDACTED]";

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.replace(EMAIL_IN_TEXT, "[email]");
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** Test seam: where serialized lines go. Defaults to the console (Workers Logs). */
export type LogSink = (level: LogLevel, line: string) => void;
const consoleSink: LogSink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export function createLogger(base: LogFields = {}, sink: LogSink = consoleSink): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    const record = { ts: new Date().toISOString(), level, event, ...base, ...fields };
    sink(level, JSON.stringify(redact(record)));
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    child: (fields) => createLogger({ ...base, ...fields }, sink),
  };
}

export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) return { errorName: err.name, errorMessage: err.message.slice(0, 500) };
  return { errorMessage: String(err).slice(0, 500) };
}
