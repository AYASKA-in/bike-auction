import { Hono } from "hono";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { z } from "zod";
import { hasherStub } from "../auth/password-hasher-do";
import { AppError } from "../lib/problem";
import type { AppEnv } from "../types";

/**
 * DAY-1 SPIKE ROUTES. Mounted only when ENVIRONMENT === "development" (see app.ts) and used by
 * scripts/spike-auth-cpu.mjs. These never run in production.
 */
export const spikeRoutes = new Hono<AppEnv>();

const HashSpike = z.object({
  mode: z.enum(["noop", "worker-scrypt", "do-scrypt", "worker-pbkdf2"]),
  iterations: z.number().int().positive().max(2_000_000).optional(),
});

spikeRoutes.post("/hash", async (c) => {
  const parsed = HashSpike.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION_FAILED", parsed.error.message);
  const { mode, iterations = 100_000 } = parsed.data;
  const password = "correct horse battery staple";
  const t0 = performance.now();
  let ok = true;
  try {
    if (mode === "worker-scrypt") {
      ok = await verifyPassword({ hash: await hashPassword(password), password });
    } else if (mode === "do-scrypt") {
      const stub = hasherStub(c.env);
      ok = await stub.verify(await stub.hash(password), password);
    } else if (mode === "worker-pbkdf2") {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveBits"],
      );
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: crypto.getRandomValues(new Uint8Array(16)),
          iterations,
        },
        key,
        256,
      );
    }
  } catch (err) {
    return c.json(
      { mode, iterations, ok: false, error: err instanceof Error ? err.message : String(err) },
      200,
    );
  }
  // performance.now() is coarsened/frozen during execution in workerd (Spectre mitigation);
  // the external script measures wall-clock latency instead. Reported for transparency.
  return c.json({ mode, iterations, ok, insideMs: performance.now() - t0 });
});
