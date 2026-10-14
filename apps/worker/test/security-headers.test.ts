import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import headersFile from "../../web/public/_headers?raw";
import indexHtml from "../../web/index.html?raw";
import {
  ADMIN_UPLOADS_PER_MINUTE,
  ADMIN_WRITES_PER_MINUTE,
  API_CSP,
  API_SECURITY_HEADERS,
  HSTS,
  PERMISSIONS_POLICY,
  SPA_CSP,
} from "../src/middleware/security";
import { BASE, mockTurnstile, signIn, signUp } from "./auth-helpers";
import { adminAndBuyer, call, pngBytes } from "./catalogue-helpers";

// Day 8: response headers (API + SPA) and the edge rate limits added for routes that had none.

function expectApiHeaders(res: Response, https: boolean) {
  for (const [k, v] of Object.entries(API_SECURITY_HEADERS)) expect(res.headers.get(k), k).toBe(v);
  expect(res.headers.get("strict-transport-security")).toBe(https ? HSTS : null);
  expect(res.headers.get("x-powered-by")).toBeNull();
}

describe("API response headers", () => {
  it("are set on JSON responses; HSTS only over HTTPS", async () => {
    expectApiHeaders(await exports.default.fetch(`${BASE}/api/v1/health`), false);
    expectApiHeaders(await exports.default.fetch("https://example.com/api/v1/health"), true);
  });

  it("are set on errors (404, 401, CSRF 403) too, which never expose internals", async () => {
    const notFound = await exports.default.fetch("https://example.com/api/v1/nope");
    expect(notFound.status).toBe(404);
    expectApiHeaders(notFound, true);
    const anon = await exports.default.fetch(`${BASE}/api/v1/me`);
    expect(anon.status).toBe(401);
    expectApiHeaders(anon, false);
    const csrf = await exports.default.fetch(`${BASE}/api/v1/me/watchlist/x`, {
      method: "PUT",
      headers: { origin: "https://evil.example" },
    });
    expect(csrf.status).toBe(403);
    expectApiHeaders(csrf, false);
    const body = await csrf.text();
    expect(body).not.toMatch(/at \w+ \(|\.ts:\d+|stack/i);
  });

  it("API CSP denies everything (the API never serves executable or embeddable content)", () => {
    expect(API_CSP).toContain("default-src 'none'");
    expect(API_CSP).toContain("frame-ancestors 'none'");
  });
});

/** Parses the `/*` block of a Cloudflare `_headers` file. */
function spaHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  let inBlock = false;
  for (const line of headersFile.split("\n")) {
    if (/^\S/.test(line)) inBlock = line.trim() === "/*";
    else if (inBlock && line.includes(":")) {
      const i = line.indexOf(":");
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}

describe("SPA headers (apps/web/public/_headers, applied by Workers Static Assets)", () => {
  it("carry the shared SPA policy verbatim (no drift between Worker and static assets)", () => {
    const h = spaHeaders();
    expect(h["Content-Security-Policy"]).toBe(SPA_CSP);
    expect(h["Strict-Transport-Security"]).toBe(HSTS);
    expect(h["Permissions-Policy"]).toBe(PERMISSIONS_POLICY);
    for (const k of [
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Resource-Policy",
      "X-Frame-Options",
    ]) {
      expect(h[k], k).toBe(API_SECURITY_HEADERS[k]);
    }
  });

  it("SPA CSP is strict and allows exactly what the app needs", () => {
    const d = Object.fromEntries(
      SPA_CSP.split(";").map((p) => {
        const [name, ...values] = p.trim().split(/\s+/);
        return [name!, values];
      }),
    );
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'", "https://challenges.cloudflare.com"]); // Turnstile
    expect(d["frame-src"]).toEqual(["https://challenges.cloudflare.com"]);
    expect(d["connect-src"]).toEqual(["'self'"]); // API + same-origin wss (CSP3 'self' matching)
    expect(d["img-src"]).toEqual(["'self'", "data:", "blob:"]); // /api/v1/images + upload previews
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(SPA_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it("index.html has no inline script or style, so the CSP needs no hashes or nonces", () => {
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(indexHtml).not.toMatch(/<style|\sstyle=/i);
  });

  it("are served with the built SPA (index and SPA fallback), when a build is present", async (ctx) => {
    const index = await env.ASSETS.fetch("https://example.com/");
    const html = await index.text();
    if (html.includes("placeholder")) ctx.skip(); // apps/web not built (scripts/ensure-assets.mjs)
    expect(index.headers.get("content-security-policy")).toBe(SPA_CSP);
    expect(index.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    const deep = await env.ASSETS.fetch("https://example.com/account", {
      headers: { "sec-fetch-mode": "navigate", accept: "text/html" },
    });
    await deep.text();
    expect(deep.headers.get("content-security-policy")).toBe(SPA_CSP);
  });
});

describe("edge rate limits added on Day 8", () => {
  it("WebSocket connects: 30 / 10 s per client IP, other IPs unaffected", async () => {
    const connect = (ip: string) =>
      exports.default.fetch(`${BASE}/api/v1/auctions/ws-limit-missing/stream`, {
        headers: { upgrade: "websocket", origin: BASE, "cf-connecting-ip": ip },
      });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await connect("203.0.113.77")).status);
    expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true); // reached the route
    expect(statuses[30]).toBe(429);
    expect((await connect("203.0.113.78")).status).toBe(404);
  });

  describe("admin", () => {
    let admin = "";
    let otherAdmin = "";
    let buyer = "";
    beforeAll(async () => {
      ({ admin, buyer } = await adminAndBuyer());
      ({ admin: otherAdmin } = await adminAndBuyer());
    });

    const adminId = async (cookie: string) =>
      ((await (await call("GET", "/me", { cookie })).json()) as { id: string }).id;
    /** Simulates `n` audited changes by this admin within the last minute. */
    async function recentChanges(cookie: string, n: number, action: string, agoMs = 1_000) {
      const id = await adminId(cookie);
      await env.DB.batch(
        Array.from({ length: n }, () =>
          env.DB.prepare(
            `INSERT INTO audit_log (id, actor_user_id, action, resource_type, resource_id, request_id, created_at)
             VALUES (?, ?, ?, 'bike', 'bike_x', 'req_t', ?)`,
          ).bind(`aud_t_${crypto.randomUUID()}`, id, action, Date.now() - agoMs),
        ),
      );
    }
    const bike = "bike_" + "0".repeat(32);
    const patch = (cookie: string) =>
      call("PATCH", `/admin/bikes/${bike}`, { cookie, body: { colour: "Red" } });
    const upload = (cookie: string) =>
      call("POST", `/admin/bikes/${bike}/images?alt=Front%20view`, {
        cookie,
        raw: pngBytes(800, 600),
        type: "image/png",
      });

    it(`mutations: ${ADMIN_WRITES_PER_MINUTE} audited changes / rolling minute per admin account`, async () => {
      await recentChanges(admin, ADMIN_WRITES_PER_MINUTE - 1, "BIKE_UPDATED");
      expect((await patch(admin)).status).not.toBe(429); // under budget: reaches the route
      await recentChanges(admin, 1, "BIKE_UPDATED");
      const limited = await patch(admin);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      // Reads are not limited by this layer; another admin has their own budget.
      expect((await call("GET", "/admin/bikes", { cookie: admin })).status).toBe(200);
      expect((await patch(otherAdmin)).status).not.toBe(429);
    });

    it("the budget is a rolling minute: older changes don't count", async () => {
      const { admin: fresh } = await adminAndBuyer();
      await recentChanges(fresh, ADMIN_WRITES_PER_MINUTE, "BIKE_UPDATED", 61_000);
      expect((await patch(fresh)).status).not.toBe(429);
    });

    it(`image uploads: ${ADMIN_UPLOADS_PER_MINUTE} / rolling minute per admin account`, async () => {
      const { admin: uploader } = await adminAndBuyer();
      await recentChanges(uploader, ADMIN_UPLOADS_PER_MINUTE - 1, "IMAGE_UPLOADED");
      expect((await upload(uploader)).status).not.toBe(429);
      await recentChanges(uploader, 1, "IMAGE_UPLOADED");
      expect((await upload(uploader)).status).toBe(429);
      expect((await patch(uploader)).status).not.toBe(429); // other changes still allowed
    });

    it("non-admins still get 403 (authz is unchanged by the limiter)", async () => {
      expect((await call("POST", "/admin/bikes", { cookie: buyer, body: {} })).status).toBe(403);
      expect((await call("POST", "/admin/bikes", { body: {} })).status).toBe(401);
    });
  });

  it("sign-in stays limited per IP and per account (unchanged)", async () => {
    const spy = mockTurnstile();
    try {
      const u = await signUp();
      for (let i = 0; i < 5; i++) await signIn(u.email, "Wrong-Password-000");
      expect((await signIn(u.email, u.password)).res.status).toBe(429);
    } finally {
      spy.mockRestore();
    }
  });
});
