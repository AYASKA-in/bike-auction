import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./migrations", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: "test",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
            // Cloudflare's documented always-pass Turnstile test secret; siteverify is mocked in tests.
            TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
            SEED_TOKEN: "test-seed-token-0123456789abcdef",
            PSEUDONYM_SECRET: "test-pseudonym-secret-0123456789abcdef",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // Files run one at a time: parallel runs on a 2-core machine hung intermittently (Day 4);
      // sequential is slower (~2 min) but deterministic for CI.
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});
