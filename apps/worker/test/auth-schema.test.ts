import { env } from "cloudflare:workers";
import { getMigrations } from "better-auth/db/migration";
import { expect, it } from "vitest";
import { createAuth } from "../src/auth/auth";

// Drift guard: after our SQL migrations, Better Auth must find nothing left to create.
it("D1 migrations contain everything Better Auth expects", async () => {
  const auth = createAuth(env, new Request("http://example.com"));
  const { toBeCreated, toBeAdded } = await getMigrations(auth.options);
  expect(toBeCreated).toEqual([]);
  expect(toBeAdded).toEqual([]);
});
