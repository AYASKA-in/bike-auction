import { describe, expect, it } from "vitest";
import { ProblemDetails, WsServerMessage, WS_PROTOCOL_VERSION } from "./index";

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

  it("rejects WS messages from a different protocol version", () => {
    expect(
      WsServerMessage.safeParse({ protocolVersion: 2, type: "hello", serverTime: 1 }).success,
    ).toBe(false);
    expect(
      WsServerMessage.safeParse({
        protocolVersion: WS_PROTOCOL_VERSION,
        type: "hello",
        serverTime: 1,
      }).success,
    ).toBe(true);
  });
});
