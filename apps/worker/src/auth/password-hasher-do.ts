import { DurableObject } from "cloudflare:workers";
import { hashPassword, verifyPassword } from "better-auth/crypto";

/**
 * Plan A candidate (BLUEPRINT §7.1): run Better Auth's *own* password hashing (node:crypto
 * scrypt, N=16384 r=16 p=1, 64-byte key) inside a Durable Object instead of the Worker.
 *
 * Why: Workers Free allows 10 ms CPU per HTTP request; SQLite-backed Durable Objects document a
 * 30 s default CPU budget per request. No custom cryptography and no weakened parameters: this
 * delegates to the exact functions Better Auth would call. Callers shard across a few instances
 * (`hasher-0..N`) so hashing does not serialise through one object.
 *
 * Status: local measurements in docs/spike-results.md. Whether the 30 s DO budget applies on the
 * Free plan is UNVERIFIED until deployed (requires Cloudflare account access).
 */
export class PasswordHasherDO extends DurableObject<Env> {
  async hash(password: string): Promise<string> {
    return hashPassword(password);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return verifyPassword({ hash, password });
  }
}

export const HASHER_SHARDS = 4;

export function hasherStub(env: Env): DurableObjectStub<PasswordHasherDO> {
  const shard = crypto.getRandomValues(new Uint8Array(1))[0]! % HASHER_SHARDS;
  return env.PASSWORD_HASHER.get(env.PASSWORD_HASHER.idFromName(`hasher-${shard}`));
}
