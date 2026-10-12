import { bidderPseudonym } from "@bike/domain";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hmacSha256 } from "../src/lib/crypto";

describe("pseudonym adapter (Web Crypto in workerd)", () => {
  it("produces stable, per-auction pseudonyms with the runtime secret", async () => {
    const a = await bidderPseudonym(hmacSha256, env.BETTER_AUTH_SECRET, "auc-1", "user-1");
    expect(a).toMatch(/^Bidder [0-9A-HJKMNP-TV-Z]{4}$/);
    expect(await bidderPseudonym(hmacSha256, env.BETTER_AUTH_SECRET, "auc-1", "user-1")).toBe(a);
    expect(await bidderPseudonym(hmacSha256, env.BETTER_AUTH_SECRET, "auc-2", "user-1")).not.toBe(
      a,
    );
  });
});
