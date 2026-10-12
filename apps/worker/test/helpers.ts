import { env } from "cloudflare:workers";

let counter = 0;
export function uniqueAuctionId(prefix = "auc"): string {
  counter += 1;
  return `${prefix}-${counter}-${crypto.randomUUID().slice(0, 8)}`;
}

export function auctionStub(id: string) {
  return env.AUCTION.get(env.AUCTION.idFromName(id));
}

export async function createLiveAuction(
  opts: { startPriceMinor?: number; closesInMs?: number } = {},
) {
  const id = uniqueAuctionId();
  const stub = auctionStub(id);
  await stub.initialize({
    auctionId: id,
    startPriceMinor: opts.startPriceMinor ?? 5_000_000,
    closesAt: Date.now() + (opts.closesInMs ?? 60 * 60 * 1000),
  });
  return { id, stub };
}

export async function waitFor(cond: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor: timed out");
}
