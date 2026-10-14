import { CURRENT_SIGN_UP_CONSENT } from "@bike/contracts";
import { exports } from "cloudflare:workers";
import { vi } from "vitest";

export const BASE = "http://example.com";
export const PASS_TOKEN = "turnstile-pass";

/**
 * Mocks Cloudflare Turnstile siteverify. The Worker under test runs in this isolate, so a global
 * fetch spy intercepts its outbound calls. Anything else passes through.
 */
export function mockTurnstile() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) {
      const body = init?.body;
      const text =
        typeof body === "string"
          ? body
          : body instanceof URLSearchParams
            ? body.toString()
            : JSON.stringify(body ?? "");
      const ok = text.includes(PASS_TOKEN);
      return Response.json({
        success: ok,
        "error-codes": ok ? [] : ["invalid-input-response"],
        hostname: "example.com",
      });
    }
    return real(input, init);
  });
}

let ipCounter = 0;
/** A distinct client IP per call site so edge rate-limit buckets don't bleed between tests. */
export function freshIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

export function uniqueEmail(tag = "user"): string {
  return `${tag}.${crypto.randomUUID().slice(0, 8)}@example.org`;
}

export async function post(
  path: string,
  body: unknown,
  opts: { cookie?: string; captcha?: string | null; ip?: string } = {},
) {
  const headers: Record<string, string> = {
    origin: BASE,
    "content-type": "application/json",
    "cf-connecting-ip": opts.ip ?? freshIp(),
  };
  if (opts.captcha !== null) headers["x-captcha-response"] = opts.captcha ?? PASS_TOKEN;
  if (opts.cookie) headers.cookie = opts.cookie;
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export async function get(path: string, cookie?: string) {
  return exports.default.fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
}

/** Turns Set-Cookie headers into a Cookie request header. */
export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export async function signUp(
  email = uniqueEmail(),
  password = "Kickstart-Pulsar-220",
  name = "Test Rider",
) {
  // Consent to the current Privacy Notice is required for sign-up (Day 8, test/privacy.test.ts).
  const res = await post("/api/v1/auth/sign-up/email", {
    email,
    password,
    name,
    consent: CURRENT_SIGN_UP_CONSENT,
  });
  return { res, email, password, cookie: cookieFrom(res) };
}

export async function signIn(email: string, password: string, ip?: string) {
  const res = await post("/api/v1/auth/sign-in/email", { email, password }, ip ? { ip } : {});
  return { res, cookie: cookieFrom(res) };
}
