import { exports } from "cloudflare:workers";
import { HealthResponse, ProblemDetails, StatusResponse } from "@bike/contracts";
import { describe, expect, it } from "vitest";

const BASE = "http://example.com";

describe("system endpoints", () => {
  it("GET /api/v1/health returns ok with request id and security headers", async () => {
    const res = await exports.default.fetch(`${BASE}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(HealthResponse.parse(await res.json()).status).toBe("ok");
    expect(res.headers.get("x-request-id")).toMatch(/^req_[a-f0-9]{32}$/);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("propagates a well-formed inbound X-Request-Id and replaces a malformed one", async () => {
    const good = await exports.default.fetch(`${BASE}/api/v1/health`, {
      headers: { "x-request-id": "trace_abc12345" },
    });
    expect(good.headers.get("x-request-id")).toBe("trace_abc12345");
    const bad = await exports.default.fetch(`${BASE}/api/v1/health`, {
      headers: { "x-request-id": "<script>" },
    });
    expect(bad.headers.get("x-request-id")).toMatch(/^req_/);
  });

  it("GET /api/v1/status checks D1", async () => {
    const res = await exports.default.fetch(`${BASE}/api/v1/status`);
    expect(res.status).toBe(200);
    const body = StatusResponse.parse(await res.json());
    expect(body.checks.d1.status).toBe("ok");
    expect(body.environment).toBe("test");
  });

  it("unknown API routes return RFC 9457 problem+json", async () => {
    const res = await exports.default.fetch(`${BASE}/api/v1/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = ProblemDetails.parse(await res.json());
    expect(body.code).toBe("NOT_FOUND");
    expect(body.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("rejects cross-origin state-changing requests (CSRF)", async () => {
    const res = await exports.default.fetch(`${BASE}/api/v1/_spike/hash`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ mode: "noop" }),
    });
    expect(res.status).toBe(403);
    expect(ProblemDetails.parse(await res.json()).code).toBe("FORBIDDEN");
  });

  it("rejects state-changing requests without an Origin header", async () => {
    const res = await exports.default.fetch(`${BASE}/api/v1/_spike/hash`, {
      method: "POST",
      body: JSON.stringify({ mode: "noop" }),
    });
    expect(res.status).toBe(403);
  });
});
