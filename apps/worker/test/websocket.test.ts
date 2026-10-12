import { evictDurableObject } from "cloudflare:test";
import { WS_PING, WS_PONG, WS_RESYNC, WsServerMessage } from "@bike/contracts";
import { describe, expect, it } from "vitest";
import { bid, createAuction } from "./helpers";
import { connect, until } from "./ws-helpers";

describe("WebSocket feed", () => {
  it("rejects cross-site upgrades (CSWSH) and unknown auctions", async () => {
    const { id } = await createAuction();
    expect((await connect(id, { origin: "https://evil.example" })).res.status).toBe(403);
    expect((await connect("auc-does-not-exist")).res.status).toBe(404);
  });

  it("hello + buyer-safe snapshot, then live events; every message matches the strict contract", async () => {
    const { id, stub } = await createAuction({
      startPriceMinor: 5_000_000,
      reserveMinor: 7_777_777,
    });
    const a = await connect(id);
    const b = await connect(id);
    expect(a.res.status).toBe(101);
    await until(() => a.messages.length >= 2 && b.messages.length >= 2);
    expect(a.messages[0]).toMatchObject({ type: "hello" });
    expect(a.messages[1]).toMatchObject({
      type: "auction.snapshot",
      view: { currentPriceMinor: null, hasReserve: true, reserveMet: false },
    });
    await bid(stub, "u1", 5_000_000);
    await until(() => b.messages.some((m) => m.type === "bid.accepted"));
    const ev = b.messages.find((m) => m.type === "bid.accepted")!;
    expect(ev).toMatchObject({
      amountMinor: 5_000_000,
      minNextBidMinor: 5_050_000,
      reserveMet: false,
    });
    expect(String(ev.bidder)).toMatch(/^Bidder [0-9A-Z]{4}$/);
    for (const m of [...a.messages, ...b.messages]) {
      expect(WsServerMessage.safeParse(m).success, JSON.stringify(m)).toBe(true);
      expect(JSON.stringify(m)).not.toMatch(/7777777|"u1"|userId/);
    }
    a.ws?.close();
    b.ws?.close();
  });

  it("broadcasts extensions, cancellation and endings, in seq order without gaps", async () => {
    const { id, stub } = await createAuction({ closesInMs: 1_200 });
    const c = await connect(id);
    await until(() => c.messages.length >= 2);
    const snapSeq = (c.messages[1] as unknown as { view: { seq: number } }).view.seq;
    await bid(stub, "u1", 5_000_000); // within 2 min of close → extension
    await bid(stub, "u2", 5_050_000); // within the NEW 2-min window → extends again
    await stub.cancel("Seller withdrew the bike");
    await until(() => c.messages.some((m) => m.type === "auction.cancelled"));
    const seqs = c.messages.filter((m) => typeof m.seq === "number").map((m) => m.seq as number);
    const events = c.messages.filter((m) => m.type !== "you.outbid" && typeof m.seq === "number");
    expect(events.map((m) => m.type)).toEqual([
      "bid.accepted",
      "auction.extended",
      "bid.accepted",
      "auction.extended",
      "auction.cancelled",
    ]);
    expect(events.map((m) => m.seq)).toEqual(events.map((_, i) => snapSeq + 1 + i));
    expect(seqs.length).toBeGreaterThan(0);
    c.ws?.close();
  });

  it("broadcasts auction.ended when the close alarm fires", async () => {
    const { id, stub } = await createAuction({ closesInMs: 300 });
    const c = await connect(id);
    await until(() => c.messages.length >= 2);
    await new Promise((r) => setTimeout(r, 350));
    await stub.getView(null); // lazy close (the alarm path is covered in auction-do.test.ts)
    await until(() => c.messages.some((m) => m.type === "auction.ended"));
    expect(c.messages.find((m) => m.type === "auction.ended")).toMatchObject({
      outcome: "NO_BIDS",
      winningBidder: null,
    });
    c.ws?.close();
  });

  it("answers heartbeats via auto-response and resync requests with a fresh snapshot", async () => {
    const { id, stub } = await createAuction();
    const c = await connect(id);
    await until(() => c.messages.length >= 2);
    c.ws?.send(WS_PING);
    await until(() => c.messages.some((m) => JSON.stringify(m) === WS_PONG));
    await bid(stub, "u1", 5_000_000);
    c.ws?.send(WS_RESYNC);
    await until(() => c.messages.filter((m) => m.type === "auction.snapshot").length === 2);
    const snap = c.messages.filter((m) => m.type === "auction.snapshot").at(-1) as unknown as {
      view: { currentPriceMinor: number };
    };
    expect(snap.view.currentPriceMinor).toBe(5_000_000);
    c.ws?.close();
  });

  it("reconnecting clients get a fresh snapshot that reflects everything they missed", async () => {
    const { id, stub } = await createAuction();
    const first = await connect(id);
    await until(() => first.messages.length >= 2);
    first.ws?.close();
    await bid(stub, "u1", 5_000_000);
    await bid(stub, "u2", 5_050_000);
    const again = await connect(id);
    await until(() => again.messages.length >= 2);
    expect(again.messages[1]).toMatchObject({
      type: "auction.snapshot",
      view: { currentPriceMinor: 5_050_000, bidCount: 2 },
    });
    again.ws?.close();
  });

  it("hibernation: sockets survive eviction and still receive broadcasts", async () => {
    const { id, stub } = await createAuction();
    const c = await connect(id);
    await until(() => c.messages.length >= 2);
    await evictDurableObject(stub, { webSockets: "hibernate" });
    await bid(stub, "u1", 5_000_000);
    await until(() => c.messages.some((m) => m.type === "bid.accepted"));
    expect(await stub.connectionCount()).toBe(1);
    c.ws?.close();
  });
});
