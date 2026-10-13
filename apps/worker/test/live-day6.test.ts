import { evictDurableObject } from "cloudflare:test";
import { WS_RESYNC } from "@bike/contracts";
import { describe, expect, it } from "vitest";
import { bid, createAuction } from "./helpers";
import { connect, until, type Msg } from "./ws-helpers";

const snapshots = (ms: Msg[]) => ms.filter((m) => m.type === "auction.snapshot");

describe("Day 6: live feed robustness (server side)", () => {
  it("client messages are rate-limited per minute, not per connection lifetime", async () => {
    const { id } = await createAuction();
    const c = await connect(id);
    let closeCode = 0;
    c.ws?.addEventListener("close", (e) => {
      closeCode = e.code;
    });
    await until(() => snapshots(c.messages).length === 1);
    for (let i = 0; i < 30; i++) c.ws?.send(WS_RESYNC);
    await until(() => snapshots(c.messages).length === 31);
    expect(closeCode).toBe(0); // 30 resyncs a minute are fine
    c.ws?.send(WS_RESYNC); // the 31st inside the same minute is abuse
    await until(() => closeCode !== 0);
    expect(closeCode).toBe(1008);
  });

  it("after a server restart, a reconnecting client gets the full state and contiguous seqs", async () => {
    const { id, stub } = await createAuction();
    const before = await connect(id);
    await until(() => before.messages.length >= 2);
    await bid(stub, "u1", 5_000_000);
    await until(() => before.messages.some((m) => m.type === "bid.accepted"));
    await evictDurableObject(stub); // the object (and its sockets) go away
    const again = await connect(id);
    await until(() => snapshots(again.messages).length === 1);
    const snap = snapshots(again.messages)[0] as unknown as {
      view: { seq: number; currentPriceMinor: number; bidCount: number };
    };
    expect(snap.view).toMatchObject({ currentPriceMinor: 5_000_000, bidCount: 1 });
    await bid(stub, "u2", 5_050_000);
    await until(() => again.messages.some((m) => m.type === "bid.accepted"));
    const ev = again.messages.find((m) => m.type === "bid.accepted")!;
    expect(ev.seq).toBe(snap.view.seq + 1); // no gap, no duplicate after the restart
    again.ws?.close();
  });

  it("events never cross auctions", async () => {
    const a = await createAuction();
    const b = await createAuction();
    const ca = await connect(a.id);
    const cb = await connect(b.id);
    await until(() => ca.messages.length >= 2 && cb.messages.length >= 2);
    await bid(b.stub, "u1", 5_000_000);
    await until(() => cb.messages.some((m) => m.type === "bid.accepted"));
    await new Promise((r) => setTimeout(r, 50));
    expect(ca.messages.some((m) => m.type === "bid.accepted")).toBe(false);
    for (const m of snapshots(ca.messages))
      expect((m as unknown as { view: { auctionId: string } }).view.auctionId).toBe(a.id);
    ca.ws?.close();
    cb.ws?.close();
  });
});
