import { hmacHex } from "../lib/crypto";
import { newId } from "../lib/ids";

export type SecurityEventType =
  | "auth.sign_up"
  | "auth.sign_in.succeeded"
  | "auth.sign_in.failed"
  | "auth.sign_in.locked"
  | "auth.sign_out"
  | "auth.captcha_failed"
  | "auth.rate_limited"
  | "admin.seed";

export async function recordSecurityEvent(
  env: Env,
  e: {
    type: SecurityEventType;
    requestId: string;
    userId?: string | null;
    subject?: string;
    ip?: string | null;
  },
): Promise<void> {
  const secret = env.BETTER_AUTH_SECRET;
  await env.DB.prepare(
    `INSERT INTO security_events (id, type, user_id, subject_hash, ip_hash, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId("sev"),
      e.type,
      e.userId ?? null,
      e.subject ? await hmacHex(secret, "subject", e.subject.toLowerCase()) : null,
      e.ip ? await hmacHex(secret, "ip", e.ip) : null,
      e.requestId,
      Date.now(),
    )
    .run();
}
