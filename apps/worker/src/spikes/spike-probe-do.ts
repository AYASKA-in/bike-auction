import { DurableObject } from "cloudflare:workers";

/**
 * DAY-1 SPIKE ONLY. Demonstrates *why* the AuctionDO critical section must contain no awaits.
 * Not routed in production. Delete together with a `deleted_classes` migration on Day 4.
 */
export class SpikeProbeDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS s (id INTEGER PRIMARY KEY CHECK (id = 1), price INTEGER NOT NULL, accepted INTEGER NOT NULL);
       INSERT OR IGNORE INTO s (id, price, accepted) VALUES (1, 100, 0);`,
    );
  }

  private read() {
    return this.ctx.storage.sql
      .exec<{ price: number; accepted: number }>(`SELECT price, accepted FROM s`)
      .one();
  }

  private write(price: number) {
    this.ctx.storage.sql.exec(`UPDATE s SET price = ?, accepted = accepted + 1`, price);
  }

  /** Correct: read → check → write with no await in between. */
  bidSafe(amount: number): boolean {
    const { price } = this.read();
    if (amount <= price) return false;
    this.write(amount);
    return true;
  }

  /** WRONG ON PURPOSE: awaits non-storage I/O between check and write. */
  async bidUnsafe(amount: number): Promise<boolean> {
    const { price } = this.read();
    if (amount <= price) return false;
    await new Promise((r) => setTimeout(r, 5)); // stands in for `await env.DB...` or `fetch()`
    this.write(amount);
    return true;
  }

  stats() {
    return this.read();
  }

  /** Demonstrates the one-alarm constraint: the second setAlarm overwrites the first. */
  async naiveTwoAlarms(first: number, second: number): Promise<number | null> {
    await this.ctx.storage.setAlarm(first);
    await this.ctx.storage.setAlarm(second);
    return this.ctx.storage.getAlarm();
  }

  override async alarm(): Promise<void> {}
}
