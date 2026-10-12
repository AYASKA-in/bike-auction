import { PublicAuctionEvent } from "@bike/contracts";
import { describe, expect, it } from "vitest";
import {
  bidFingerprint,
  bidderPseudonym,
  cancel,
  codeFromDigest,
  encodeBase32,
  IDEMPOTENCY_RETENTION_MS,
  isValidIdempotencyKey,
  makeIdempotencyRecord,
  pseudonymMessage,
  resolveIdempotency,
  tick,
  toPublicEvent,
  type HmacSha256,
} from "../src";
import { bid, CLOSE, expectOk, live, START } from "./helpers";

/** Test adapter over the standard Web Crypto API (Node 22 / workerd). */
const hmac: HmacSha256 = async (secret, message) => {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
};
const SECRET = "test-only-secret-test-only-secret-0001";

describe("idempotency decisions", () => {
  const req = {
    userId: "u1",
    key: "k-0123456789abcdef",
    fingerprint: bidFingerprint({ auctionId: "auc-test", amountMinor: 5_000_000 }),
  };

  it("validates key format", () => {
    expect(isValidIdempotencyKey(crypto.randomUUID())).toBe(true);
    expect(isValidIdempotencyKey("short")).toBe(false);
    expect(isValidIdempotencyKey("has spaces in it!!!!")).toBe(false);
    expect(isValidIdempotencyKey(42)).toBe(false);
  });

  it("new → replay with the original stored result → conflict on a different payload", () => {
    expect(resolveIdempotency(undefined, req, START)).toEqual({ kind: "new" });
    const decision = bid(live(), "u1", 5_000_000, START + 1);
    const record = makeIdempotencyRecord(req, decision, START + 1);
    expect(record.result).toMatchObject({
      ok: true,
      amountMinor: 5_000_000,
      minNextBidMinor: 5_050_000,
    });
    expect(resolveIdempotency(record, req, START + 2)).toEqual({
      kind: "replay",
      result: record.result,
    });
    const other = {
      ...req,
      fingerprint: bidFingerprint({ auctionId: "auc-test", amountMinor: 6_000_000 }),
    };
    expect(resolveIdempotency(record, other, START + 2)).toEqual({ kind: "conflict" });
  });

  it("stores rejections too, so a retry sees the original answer", () => {
    const decision = bid(live(), "u1", 1, START + 1);
    expect(makeIdempotencyRecord(req, decision, START).result).toEqual({
      ok: false,
      code: "BID_TOO_LOW",
      minNextBidMinor: 5_000_000,
    });
  });

  it("records expire after the retention period (≥ 24 h)", () => {
    expect(IDEMPOTENCY_RETENTION_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    const record = makeIdempotencyRecord(req, bid(live(), "u1", 5_000_000, START + 1), START);
    expect(resolveIdempotency(record, req, START + IDEMPOTENCY_RETENTION_MS - 1).kind).toBe(
      "replay",
    );
    expect(resolveIdempotency(record, req, START + IDEMPOTENCY_RETENTION_MS).kind).toBe("new");
  });

  it("refuses records from another scope (caller bug)", () => {
    const record = makeIdempotencyRecord(req, bid(live(), "u1", 5_000_000, START + 1), START);
    expect(() => resolveIdempotency(record, { ...req, userId: "u2" }, START)).toThrow();
  });

  it("fingerprints exclude server-assigned values and distinguish malformed payloads", () => {
    expect(bidFingerprint({ auctionId: "a1x", amountMinor: 100 })).toBe("bid:v1:a1x:100");
    expect(bidFingerprint({ auctionId: "a1x", amountMinor: "100" })).not.toBe(
      bidFingerprint({ auctionId: "a1x", amountMinor: 100 }),
    );
  });
});

describe("bidder pseudonyms", () => {
  it("are stable within an auction and differ across auctions", async () => {
    const a1 = await bidderPseudonym(hmac, SECRET, "auc-one", "user-1");
    expect(a1).toMatch(/^Bidder [0-9A-HJKMNP-TV-Z]{4}$/);
    expect(await bidderPseudonym(hmac, SECRET, "auc-one", "user-1")).toBe(a1);
    expect(await bidderPseudonym(hmac, SECRET, "auc-two", "user-1")).not.toBe(a1);
    expect(await bidderPseudonym(hmac, SECRET, "auc-one", "user-2")).not.toBe(a1);
    expect(a1).not.toContain("user-1");
  });

  it("depend on the secret", async () => {
    const other = "another-test-secret-another-test-sec";
    expect(await bidderPseudonym(hmac, other, "auc-one", "user-1")).not.toBe(
      await bidderPseudonym(hmac, SECRET, "auc-one", "user-1"),
    );
  });

  it("refuse weak secrets and ambiguous inputs", async () => {
    await expect(bidderPseudonym(hmac, "short", "auc-one", "user-1")).rejects.toThrow();
    expect(() => pseudonymMessage("a:b", "u")).toThrow();
    await expect(
      bidderPseudonym(async () => new Uint8Array(8), SECRET, "auc-one", "u"),
    ).rejects.toThrow();
  });

  it("grow the code on collision with a different bidder", async () => {
    const digest = await hmac(SECRET, pseudonymMessage("auc-one", "user-1"));
    const four = codeFromDigest(digest);
    const six = codeFromDigest(digest, (c) => c === four);
    expect(six).toHaveLength(6);
    expect(six.startsWith(four)).toBe(true);
    expect(() => codeFromDigest(digest, () => true)).toThrow();
  });

  it("base32 encoding is big-endian Crockford", () => {
    expect(encodeBase32(new Uint8Array([0, 0, 0, 0, 0]), 8)).toBe("00000000");
    expect(encodeBase32(new Uint8Array([255, 255, 255, 255, 255]), 8)).toBe("ZZZZZZZZ");
    expect(() => encodeBase32(new Uint8Array(1), 4)).toThrow(RangeError);
  });
});

describe("public events", () => {
  it("strip user ids and reserves, and satisfy the strict public contract", () => {
    const pseudo = (u: string) => `Bidder ${u === "u1" ? "AAAA" : "BBBB"}`;
    let s = live({ reserveMinor: 9_000_000 });
    const events = [];
    let r = expectOk(bid(s, "u1", 5_000_000, START + 1));
    events.push(...r.events);
    s = r.state;
    r = expectOk(bid(s, "u2", 9_000_000, CLOSE - 1000));
    events.push(...r.events);
    events.push(...tick(r.state, CLOSE + 999_999).events);
    events.push(...cancel(live(), { reason: "Listing error", now: START + 5 }).events);
    const pub = events.map((e) => toPublicEvent(e, pseudo)).filter((e) => e !== null);
    expect(pub.map((e) => e.type)).toEqual([
      "bid.accepted",
      "bid.accepted",
      "auction.extended",
      "auction.ended",
      "auction.cancelled",
    ]);
    for (const e of pub) {
      expect(PublicAuctionEvent.parse(e)).toEqual(e);
      expect(JSON.stringify(e)).not.toMatch(/"userId"|winnerUserId|reserveMinor|"u1"|"u2"/);
    }
    expect(pub[3]).toMatchObject({ outcome: "SOLD", winningBidder: "Bidder BBBB" });
  });

  it("admin-only events have no public form", () => {
    const created = live().seq;
    expect(created).toBe(3);
    expect(
      toPublicEvent(
        {
          type: "auction.created",
          seq: 1,
          at: 0,
          startPriceMinor: 1,
          reserveMinor: 5,
          startsAt: 0,
          closesAt: 1,
        },
        String,
      ),
    ).toBeNull();
    expect(
      toPublicEvent({ type: "auction.updated", seq: 2, at: 0, fields: ["reserveMinor"] }, String),
    ).toBeNull();
    expect(
      toPublicEvent(
        { type: "auction.scheduled", seq: 2, at: 0, startsAt: 1, closesAt: 2, hardCloseAt: 3 },
        String,
      ),
    ).toEqual({
      type: "auction.scheduled",
      seq: 2,
      startsAt: 1,
      closesAt: 2,
    });
    expect(
      toPublicEvent({ type: "auction.started", seq: 3, at: 0, startedAt: 1 }, String),
    ).toMatchObject({ type: "auction.started" });
  });
});
