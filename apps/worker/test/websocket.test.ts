import { evictDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { WS_PING, WS_PONG } from "@bike/contracts";
import { describe, expect, it } from "vitest";
import { createLiveAuction } from "./helpers";

const BASE = "http://example.com";

async function connect(id: string, origin = BASE) {
  const res = await exports.default.fetch(`${BASE}/api/v1/auctions/${id}/stream`, {
    headers: { upgrade: "websocket", origin },
  });
  const ws = res.webSocket;
  if (!ws) return { res, ws: null, messages: [] as Record<string, unknown>[] };
  const messages: Record<string, unknown>[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(JSON.parse(e.data as string));
  });
  ws.accept();
  return { res, ws, messages };
}

async function until(pred: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("WebSocket feed", () => {
  it("rejects cross-site WebSocket upgrades (CSWSH)", async () => {
    const { id } = await createLiveAuction();
    const { res } = await connect(id, "https://evil.example");
    expect(res.status).toBe(403);
  });

  it("sends hello + snapshot on connect, then live bid events", async () => {
    const { id, stub } = await createLiveAuction({ startPriceMinor: 5_000_000 });
    const a = await connect(id);
    const b = await connect(id);
    expect(a.res.status).toBe(101);
    await until(() => a.messages.length >= 2 && b.messages.length >= 2);
    expect(a.messages[0]).toMatchObject({ type: "hello", protocolVersion: 1 });
    expect(a.messages[1]).toMatchObject({
      type: "auction.snapshot",
      currentPriceMinor: null,
      seq: 1,
    });
    expect(await stub.connectionCount()).toBe(2);

    await stub.placeBid({ bidId: "b1", userId: "u1", amountMinor: 5_000_000 });
    await until(() => b.messages.some((m) => m.type === "bid.accepted"));
    expect(b.messages.find((m) => m.type === "bid.accepted")).toMatchObject({
      seq: 2,
      amountMinor: 5_000_000,
      minNextBidMinor: 5_050_000,
    });
    a.ws?.close();
    b.ws?.close();
  });

  it("answers heartbeats via auto-response", async () => {
    const { id } = await createLiveAuction();
    const c = await connect(id);
    await until(() => c.messages.length >= 2);
    c.ws?.send(WS_PING);
    await until(() => c.messages.some((m) => JSON.stringify(m) === WS_PONG));
    c.ws?.close();
  });

  it("hibernation: sockets survive object eviction and still receive broadcasts", async () => {
    const { id, stub } = await createLiveAuction({ startPriceMinor: 5_000_000 });
    const c = await connect(id);
    await until(() => c.messages.length >= 2);

    await evictDurableObject(stub, { webSockets: "hibernate" });

    // The next RPC re-creates the object; the hibernated socket is still attached to it.
    await stub.placeBid({ bidId: "b-after-evict", userId: "u1", amountMinor: 5_000_000 });
    await until(() => c.messages.some((m) => m.type === "bid.accepted"));
    expect(await stub.connectionCount()).toBe(1);
    c.ws?.close();
  });
});
