import { hmacHex } from "../lib/crypto";

/**
 * Per-account progressive backoff. Keyed by HMAC(email) whether or not the account exists, so the
 * response is identical for real and fake accounts. A locked account is rejected *before* any
 * password hashing, which also caps the CPU an attacker can burn.
 */
export const FREE_FAILURES = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;

export function lockDurationMs(failures: number): number {
  if (failures < FREE_FAILURES) return 0;
  return Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (failures - FREE_FAILURES));
}

async function keyFor(env: Env, email: string) {
  return hmacHex(env.BETTER_AUTH_SECRET, "login", email.trim().toLowerCase());
}

/** Returns ms until unlock, or 0 if attempts are allowed. */
export async function lockedForMs(env: Env, email: string, now = Date.now()): Promise<number> {
  const row = await env.DB.prepare(`SELECT locked_until FROM login_throttle WHERE key = ?`)
    .bind(await keyFor(env, email))
    .first<{ locked_until: number }>();
  return row ? Math.max(0, row.locked_until - now) : 0;
}

export async function recordFailure(env: Env, email: string, now = Date.now()): Promise<number> {
  const key = await keyFor(env, email);
  const row = await env.DB.prepare(
    `INSERT INTO login_throttle (key, failures, locked_until, updated_at) VALUES (?1, 1, 0, ?2)
     ON CONFLICT(key) DO UPDATE SET failures = failures + 1, updated_at = ?2
     RETURNING failures`,
  )
    .bind(key, now)
    .first<{ failures: number }>();
  const failures = row?.failures ?? 1;
  const lock = lockDurationMs(failures);
  if (lock > 0) {
    await env.DB.prepare(`UPDATE login_throttle SET locked_until = ? WHERE key = ?`)
      .bind(now + lock, key)
      .run();
  }
  return failures;
}

export async function recordSuccess(env: Env, email: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM login_throttle WHERE key = ?`)
    .bind(await keyFor(env, email))
    .run();
}
