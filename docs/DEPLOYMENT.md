# Deployment checklist (Cloudflare Workers, free plan)

**Status: deployed 14 Oct 2026** to https://bike-auction.skiranbot.workers.dev (version `6e3355d`), free plan,
no R2, demo mode off. Checked on Cloudflare: `/api/v1/status` reports the version with D1 `ok`; CSP, HSTS and
`nosniff` headers present; the Turnstile widget renders under the CSP. Not yet checked on Cloudflare: the signed-in
smoke test below (registration, bidding, live updates, close), WebSockets, alarms and the cron run.

Deploy notes learned on the first run: wrangler 4.149's `d1 create` offers to rewrite `wrangler.jsonc` (the script
now restores it and builds the deploy config by parsing it), and Analytics Engine must be enabled once in the
dashboard (free) before the first deploy.

## What you (the account owner) must do

1. **Wrangler login, in your own terminal.** Logging in on the Cloudflare website does **not** authenticate Wrangler.
   The deploy script runs `wrangler login` (opens a browser) if needed; `npx wrangler whoami` shows the result.
2. **Create a Turnstile widget (free):** Dashboard → Turnstile → Add widget → hostname
   `<your-worker>.<your-subdomain>.workers.dev` (find it after the first deploy, or add it later) → copy the
   site key and secret key.
3. **Run the deploy** from the repo root (PowerShell, macOS or Linux):

   ```bash
   corepack enable && pnpm install
   node scripts/deploy.mjs --turnstile-site-key <site key> --turnstile-secret-key <secret key>
   ```

   **On Windows you can instead double-click `deploy-windows.cmd`.** It installs dependencies, asks for the two
   keys (the secret is typed hidden) and runs the same script.

   **Use `node scripts/deploy.mjs`, not `pnpm deploy`.** In pnpm 10, `pnpm deploy` runs pnpm's own built-in
   command instead of this script.

## Flags

| Flag               | Effect                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_           | Refuses to deploy without real Turnstile keys (the test keys would let anyone pass the bot check)                                                                                                               |
| `--test-turnstile` | **Short-lived verification deploy** with Cloudflare's always-pass test keys; runs the 20× register/login gate (checks password hashing within the free plan's CPU limit). Re-deploy with real keys right after. |
| `--demo`           | Seeds the demo accounts and fictional catalogue and shows demo sign-in buttons. **Evaluation only:** the demo passwords are public.                                                                             |
| `--with-r2`        | Creates and binds the private R2 bucket for photos. **Only after you approve R2** (Cloudflare may ask for a payment method). Without it, photo upload answers 503 and listings show placeholders.               |
| `--skip-gate`      | Don't run the 20× auth gate                                                                                                                                                                                     |

## What the script does, and what each step needs

| Step            | Details                                                                                                                                                                                                               | Verified               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| D1 database     | `wrangler d1 create bike-auction` if missing; writes its id into `wrangler.jsonc`                                                                                                                                     | ⏳                     |
| Build           | `pnpm build` (SPA + Worker bundle)                                                                                                                                                                                    | ✅                     |
| Migrations      | `wrangler d1 migrations apply DB --remote` (0001–0006)                                                                                                                                                                | ✅ local · ⏳ remote   |
| Durable Objects | `AuctionDO`, `PasswordHasherDO` (SQLite-backed, declared in `wrangler.jsonc` migrations)                                                                                                                              | ✅ local · ⏳ remote   |
| Bindings        | `DB` (D1), `AUCTION`/`PASSWORD_HASHER` (DO), `ASSETS`, `AUTH_RATE_LIMIT`/`BID_RATE_LIMIT` (Rate Limiting), `METRICS` (Analytics Engine, optional, free), `IMAGES` (R2, only with `--with-r2`), daily cron (retention) | ✅ dry run · ⏳ remote |
| Secrets         | Generated once and kept in `apps/worker/.deploy-secrets.json` (git-ignored): `BETTER_AUTH_SECRET`, `PSEUDONYM_SECRET`, `SEED_TOKEN`; plus your `TURNSTILE_SECRET_KEY`. Set with `wrangler secret bulk`.               | ⏳                     |
| Vars            | `ENVIRONMENT=production`, `APP_VERSION=<git sha>`, `TURNSTILE_SITE_KEY`, `DEMO_MODE=false` (true only with `--demo`), retention periods                                                                               | ✅                     |
| Health          | Waits until `/api/v1/status` reports the new version                                                                                                                                                                  | ⏳                     |

Production safety built in:

- The Worker **refuses to start** outside `ENVIRONMENT=development` without a Turnstile secret, so the captcha
  can't be silently disabled.
- Session cookies are `Secure` on HTTPS.
- HSTS is sent only over HTTPS.

## Initial administrator

The demo seed (`--demo`) creates a demo admin with a public password, which is **not suitable for a real site**.
For a real deployment:

1. Register normally.
2. Promote your account with
   `npx wrangler d1 execute bike-auction --remote --command "UPDATE \"user\" SET role='ADMIN' WHERE email='you@example.com'"`
   (from `apps/worker`).
3. Sign out and back in.

## Post-deployment smoke test (5 minutes)

1. `curl https://<worker>/api/v1/health`, which should return `{"status":"ok", …}` and security headers.
2. **Check the captcha and HTTPS cookies:** register a buyer in a browser (the Turnstile widget appears and passes),
   then sign out and back in. In DevTools, the session cookie should be `Secure; HttpOnly`.
3. **Check live bidding:** as admin, create a bike, add an inspection, create an auction that starts now and closes
   in 10 minutes, and schedule it.
4. In two browsers, as two buyers, open the auction. A bid in one must appear in the other within about a second.
5. **Check proxy bidding:** set a maximum in one browser; a lower manual bid in the other is countered automatically.
6. **Check the close:** wait for the close. Both browsers should show the same result, and `/admin/ops` should show
   no lag, with the ledger visible on the auction's admin page.
7. **Check the cleanup job:** the next day, confirm it ran: `npx wrangler tail` around 03:17 IST, or the
   `retention.run` log line.

## Rollback

```bash
cd apps/worker
npx wrangler deployments list     # find the previous version
npx wrangler rollback             # roll back to it
```

D1 migrations are additive. To restore data, use D1 Time Travel:
`npx wrangler d1 time-travel restore bike-auction --timestamp <ISO time>`. See [`runbook.md`](runbook.md).

## Not verified on Cloudflare yet (production blockers)

- **Password hashing CPU:** scrypt runs in `PasswordHasherDO` and takes about 91 ms of CPU. It should stay within the
  free plan's limits, but only the 20× gate on the real plan can confirm it.
- **Turnstile:** widget load and validation under the CSP.
- **Real network behaviour:** WebSockets through Cloudflare's edge, alarms, D1 latency, Analytics Engine writes,
  and the cron trigger.
- **R2:** not enabled. It needs your approval.
- **Other blockers:**
  - a custom domain, if wanted;
  - backup arrangements (D1 Time Travel covers 30 days on the free plan; export for longer);
  - legal review of the privacy notice.
