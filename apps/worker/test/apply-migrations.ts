import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs inside the Workers runtime before each test file: real SQL migrations against local D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
