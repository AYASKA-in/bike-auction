import { describe, expect, it } from "vitest";
import { ProblemDetails, SetMaxBidBody, WsServerMessage, WS_PROTOCOL_VERSION } from "./index";

describe("contracts", () => {
  it("accepts an RFC 9457 problem with extension members", () => {
    const parsed = ProblemDetails.parse({
      type: "https://bike-auction.dev/errors/bid-too-low",
      title: "Bid too low",
      status: 409,
      code: "BID_TOO_LOW",
      requestId: "req_1",
      minNextBidMinor: 8_200_000,
    });
    expect(parsed.minNextBidMinor).toBe(8_200_000);
  });

  it("rejects unknown error codes", () => {
    expect(() =>
      ProblemDetails.parse({ type: "x", title: "x", status: 400, code: "NOPE", requestId: "r" }),
    ).toThrow();
  });

  it("Day 7 additions are strict: bid kind is an enum; max-bid bodies reject extra keys", () => {
    const ev = {
      protocolVersion: WS_PROTOCOL_VERSION,
      type: "bid.accepted",
      seq: 4,
      bidId: "b",
      bidder: "Bidder K7Q2",
      amountMinor: 100,
      at: 1,
      closesAt: 2,
      minNextBidMinor: 200,
      reserveMet: true,
    };
    expect(WsServerMessage.safeParse({ ...ev, kind: "PROXY" }).success).toBe(true);
    expect(WsServerMessage.safeParse(ev).success).toBe(true); // older producers
    expect(WsServerMessage.safeParse({ ...ev, kind: "AUTO" }).success).toBe(false);
    expect(WsServerMessage.safeParse({ ...ev, kind: "PROXY", maxMinor: 900 }).success).toBe(false);
    expect(SetMaxBidBody.safeParse({ maxMinor: 900 }).success).toBe(true);
    expect(SetMaxBidBody.safeParse({ maxMinor: 900, userId: "x" }).success).toBe(false);
    expect(SetMaxBidBody.safeParse({ maxMinor: 9.5 }).success).toBe(false);
  });

  it("rejects WS messages from a different protocol version", () => {
    expect(
      WsServerMessage.safeParse({ protocolVersion: 2, type: "hello", serverTime: 1 }).success,
    ).toBe(false);
    expect(
      WsServerMessage.safeParse({
        protocolVersion: WS_PROTOCOL_VERSION,
        type: "bid.accepted",
        seq: 4,
        bidId: "b",
        bidder: "Bidder K7Q2",
        amountMinor: 100,
        at: 1,
        closesAt: 2,
        minNextBidMinor: 200,
        reserveMet: true,
        userId: "leak",
      }).success,
    ).toBe(false); // strict: extra fields such as user ids are rejected
    expect(
      WsServerMessage.safeParse({
        protocolVersion: WS_PROTOCOL_VERSION,
        type: "hello",
        serverTime: 1,
      }).success,
    ).toBe(true);
  });
});
