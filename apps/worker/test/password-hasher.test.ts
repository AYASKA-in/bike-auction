import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("PasswordHasherDO (Plan A candidate)", () => {
  it("hashes with Better Auth's scrypt format and verifies inside a Durable Object", async () => {
    const stub = env.PASSWORD_HASHER.get(env.PASSWORD_HASHER.idFromName("hasher-test"));
    const hash = await stub.hash("correct horse battery staple");
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/); // salt:key (16-byte salt, 64-byte key)
    expect(await stub.verify(hash, "correct horse battery staple")).toBe(true);
    expect(await stub.verify(hash, "wrong password")).toBe(false);
    expect(await stub.hash("same")).not.toBe(await stub.hash("same")); // random salt
  });
});
