import { env } from "cloudflare:workers";

let counter = 0;
export function uniqueAuctionId(prefix = "auc"): string {
  counter += 1;
  return `${prefix}-${counter}-${crypto.randomUUID().slice(0, 8)}`;
}

export function auctionStub(id: string) {
  return env.AUCTION.get(env.AUCTION.idFromName(id));
}

/**
 * Creates a scheduled auction through the real DO command path. By default it started a minute ago
 * (so it is LIVE immediately) and closes in an hour. Real time is used: the DO reads Date.now().
 */
export async function createAuction(
  opts: {
    startPriceMinor?: number;
    reserveMinor?: number | null;
    closesInMs?: number;
    startsInMs?: number;
    antiSniping?: boolean;
  } = {},
) {
  const id = uniqueAuctionId();
  const stub = auctionStub(id);
  const now = Date.now();
  const startsAt = opts.startsInMs === undefined ? now - 60_000 : now + opts.startsInMs;
  const closesAt = now + (opts.closesInMs ?? 60 * 60 * 1000);
  const r = await stub.create({
    auctionId: id,
    startPriceMinor: opts.startPriceMinor ?? 5_000_000,
    reserveMinor: opts.reserveMinor ?? null,
    startsAt,
    closesAt: Math.max(closesAt, startsAt + 60_000),
    schedule: true,
    antiSniping: opts.antiSniping ?? true,
  });
  if (!r.ok) throw new Error(`create failed: ${r.error.code} ${r.error.message}`);
  return { id, stub };
}
export const createLiveAuction = createAuction;

export function key(): string {
  return `k-${crypto.randomUUID()}`;
}

export async function bid(
  stub: ReturnType<typeof auctionStub>,
  userId: string,
  amountMinor: number,
  idempotencyKey = key(),
) {
  return stub.placeBid({ userId, amountMinor, idempotencyKey, requestId: "req_test" });
}

export async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor: timed out");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Committed internal event log of an auction (test-only introspection). */
export async function eventLog(stub: ReturnType<typeof auctionStub>) {
  const { runInDurableObject } = await import("cloudflare:test");
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql
      .exec<{ seq: number; type: string; payload_json: string }>(
        `SELECT seq, type, payload_json FROM events ORDER BY seq`,
      )
      .toArray(),
  );
}
