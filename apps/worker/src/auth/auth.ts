import { betterAuth } from "better-auth";
import { captcha } from "better-auth/plugins";
import { allowedOrigins } from "../middleware/security";
import { hasherStub } from "./password-hasher-do";

export const AUTH_BASE_PATH = "/api/v1/auth";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Turnstile is mandatory outside development: fail closed if it is not configured. */
export function turnstileEnabled(env: Env): boolean {
  if (env.TURNSTILE_SECRET_KEY) return true;
  if (env.ENVIRONMENT === "development") return false;
  throw new Error("TURNSTILE_SECRET_KEY must be set outside development");
}

/**
 * Better Auth, configured per request (bindings are request-scoped in Workers).
 *
 * - Storage: D1 directly (Better Auth's built-in D1 dialect; no interactive transactions).
 * - Password hashing: Better Auth's own scrypt, executed in PasswordHasherDO to stay outside the
 *   Worker's 10 ms Free-plan CPU budget (ADR 002). No custom crypto, no weakened parameters.
 * - Cookies: HttpOnly, SameSite=Lax, Secure + `__Secure-` prefix on HTTPS.
 * - Roles: `role` is a server-only field (`input: false`); sign-up cannot set it.
 */
export function createAuth(env: Env, request: Request) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be set (>= 32 chars)");
  }
  const origin = new URL(request.url).origin;
  const https = origin.startsWith("https://");
  return betterAuth({
    appName: "Bike Auction",
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    telemetry: { enabled: false },
    trustedOrigins: [origin, ...allowedOrigins(env)],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
      requireEmailVerification: false, // no email provider in the free deployment (docs/assumptions.md)
      password: {
        hash: (password) => hasherStub(env).hash(password),
        verify: ({ hash, password }) => hasherStub(env).verify(hash, password),
      },
    },
    user: {
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "USER", input: false },
      },
    },
    session: { expiresIn: SESSION_TTL_SECONDS, updateAge: 24 * 60 * 60 },
    // Abuse controls live in our own layer (rate-limit binding + per-account backoff), because
    // Better Auth's in-memory limiter is per-isolate on Workers.
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: https,
      cookiePrefix: "ba",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: https, path: "/" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    plugins: turnstileEnabled(env)
      ? [captcha({ provider: "cloudflare-turnstile", secretKey: env.TURNSTILE_SECRET_KEY! })]
      : [],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Creates the auth instance AND completes its async initialisation inside the current request.
 * Workers forbids resuming I/O started by a different request; an instance created but left
 * initialising in one request wedged later requests (found by test/auth.test.ts).
 */
export async function getAuth(env: Env, request: Request): Promise<Auth> {
  const auth = createAuth(env, request);
  await auth.$context;
  return auth;
}
