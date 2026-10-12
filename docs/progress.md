# Progress

## Day 1 (12 Oct 2026): foundation and spikes, complete locally

**Done**

- pnpm monorepo: `apps/web`, `apps/worker`, `packages/domain`, `packages/contracts`; strict TS
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESLint, Prettier, EditorConfig, git.
- Worker: Hono app with request ids, redacting JSON logger, secure headers + CSP, CSRF origin guard,
  RFC 9457 errors, `/api/v1/health`, `/api/v1/status` (D1 check), auction snapshot + WebSocket stream routes.
- `AuctionDO` (Day-1 minimal engine): SQLite schema with versioned migrations, atomic `placeBid`, lazy close,
  alarm multiplexer, outbox → D1 projection with backoff, hibernatable WebSockets.
- `PasswordHasherDO` (auth Plan A candidate). `SpikeProbeDO` (spike-only).
- D1 migration `0001_init.sql` (auctions_rm, audit_log), applied in tests and locally.
- Domain: money (paise, en-IN formatting), increment ladder + validation, injectable clock; unit + fast-check tests.
- Contracts: error codes, problem details, health/status, WS protocol v1 (Zod).
- Web: React 19 + Vite 8 + Tailwind 4 + TanStack Router/Query; app shell, home page with live server-synced
  auction clock, empty state, "how bidding works", status footer; self-hosted Archivo font; CSP `_headers`.
- CI: GitHub Actions (format, lint, wrangler types check, typecheck, build, tests) + gitleaks + Dependabot.

**Verification (real runs)**

- `pnpm check` → format ✓, lint ✓ (0 warnings), typecheck ✓ (4 packages), build ✓, tests ✓:
  domain 12, contracts 3, web 3, worker 24 (in workerd) = **42 passed**. Worker suite re-run 3× more: 24/24 each time.
- Local smoke via `wrangler dev`: `/api/v1/health` 200 with `X-Request-Id` + CSP; `/api/v1/status` d1 ok;
  SPA deep link `/auctions/x` → 200 index.html; unknown API → 404 problem+json. Screenshots checked at 1366 px and 390 px.

**Blockers / needs your action**

- No Cloudflare account access yet: nothing deployed; DO CPU budget on Free unverified (auth gate).
- Before first deploy: `wrangler login`, `wrangler d1 create bike-auction` (put id in wrangler.jsonc),
  `wrangler r2 bucket create bike-auction-images`. Deployment only with your approval.

## Next: Day 2 (auth and roles)

1. Deploy to `workers.dev` (with approval) and run the Plan-A gate (20 register/login cycles, check CPU errors).
2. Better Auth + D1 (Kysely D1 dialect), hashing via `PasswordHasherDO`; `__Host-` session cookie; roles table.
3. `requireUser` / `requireAdmin` middleware; 401/403 test matrix over all `/admin/*` routes.
4. Turnstile on register/login (test keys locally); per-account failure backoff into `security_events`.
5. Seed demo accounts (Buyer A, Buyer B, Admin); login/register pages in the shell.
