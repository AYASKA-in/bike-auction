# Run your own copy on Cloudflare (from a fresh clone)

This guide takes you from `git clone` to your own live copy of the Bike Auction Platform on **your own
Cloudflare account**. It uses only the free plan: no credit card and no paid services. Allow about 30 minutes
the first time.

You end up with:

- the app at `https://bike-auction.<your-subdomain>.workers.dev`;
- an admin account;
- live bidding over WebSockets;
- the payment (settlement) cron.

> Short version, for people who know Cloudflare:
>
> 1. `corepack enable && pnpm install`
> 2. `npx wrangler login`
> 3. In the dashboard, enable Analytics Engine.
> 4. Create a Turnstile widget for your `workers.dev` hostname.
> 5. `node scripts/deploy.mjs --turnstile-site-key <site> --turnstile-secret-key <secret>`
> 6. Register on the site, then promote yourself to admin with one `wrangler d1 execute` command.
>
> Everything below explains each step in detail.

---

## 1. What gets created in your Cloudflare account

The deploy script creates and binds all of this for you. Nothing here needs a payment method.

| Resource                 | Name                                                                           | Purpose                                                                         | Free-plan limit that matters                 |
| ------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------- |
| Worker                   | `bike-auction`                                                                 | API + the React app (static assets), same origin                                | 100,000 requests/day, 10 ms CPU per request  |
| Durable Objects (SQLite) | `AuctionDO`, `PasswordHasherDO`                                                | One object per auction (bids, ledger, WebSockets); password hashing             | Free with SQLite storage                     |
| D1 database              | `bike-auction`                                                                 | Accounts, catalogue, read models, settlements, audit log (migrations 0001–0007) | 5 GB, 5M rows read/day                       |
| Workers KV namespace     | `bike-auction-photos`                                                          | Bike photos (used when R2 is not enabled)                                       | 1,000 writes/day (≈ 1,000 photo uploads/day) |
| Analytics Engine dataset | `bike_auction_metrics`                                                         | Metrics (bids, rejections, WebSockets, projection lag)                          | 100k data points written/day                 |
| Rate Limiting bindings   | `AUTH_RATE_LIMIT`, `BID_RATE_LIMIT`                                            | 20 sign-in attempts/min, 30 bids/10 s per client                                | Free                                         |
| Cron triggers            | `47 21 * * *`, `*/5 * * * *`                                                   | Daily retention cleanup (03:17 IST); settlement sweep every 5 minutes           | 5 cron triggers per account                  |
| Secrets                  | `BETTER_AUTH_SECRET`, `PSEUDONYM_SECRET`, `SEED_TOKEN`, `TURNSTILE_SECRET_KEY` | Session signing, bidder pseudonyms, seeding, bot check                          | —                                            |
| R2 bucket (optional)     | `bike-auction-images`                                                          | Photos in object storage; **only with `--with-r2`**                             | R2 may ask for a payment method              |

You also create **one Turnstile widget** (free) by hand in the dashboard (step 4).

---

## 2. Prerequisites on your computer

| Tool    | Version                    | Check with      | Install                                                    |
| ------- | -------------------------- | --------------- | ---------------------------------------------------------- |
| Node.js | 22 or newer                | `node -v`       | https://nodejs.org (LTS)                                   |
| pnpm    | 10                         | `pnpm -v`       | `corepack enable` (ships with Node)                        |
| Git     | any recent                 | `git --version` | https://git-scm.com                                        |
| Browser | any normal desktop browser | —               | Used once for `wrangler login` and for the Turnstile check |

Windows, macOS and Linux all work. On Windows, either PowerShell or the provided double-click script works
(step 5).

You also need a **Cloudflare account**, which is free. Sign up at https://dash.cloudflare.com/sign-up and verify
your email.

---

## 3. Clone and install

```bash
git clone https://github.com/AYASKA-in/bike-auction.git
cd bike-auction
corepack enable
pnpm install
```

Optional but recommended: confirm the code builds and its tests pass on your machine before deploying.

```bash
pnpm check     # format, lint, typecheck, ~640 tests, production build + deploy dry run (5–6 min)
```

You can also try it locally first with `pnpm dev` (see the README, _Run it locally_). Local runs need no Cloudflare account.

---

## 4. One-time setup in the Cloudflare dashboard

### 4.1 Choose your workers.dev subdomain

1. Open https://dash.cloudflare.com, then **Workers & Pages**.
2. If asked, pick a subdomain, for example `yourname`. Your app's address will be
   `https://bike-auction.yourname.workers.dev`.
3. Write down that hostname: Turnstile needs it in step 4.3.

(If you skip this, `wrangler` asks you to register a subdomain on the first deploy.)

### 4.2 Enable Analytics Engine (free, once)

**Workers & Pages → Analytics Engine → Enable.** The first deploy fails with an Analytics Engine error until
this is done. Analytics Engine is free on the free plan.

### 4.3 Create a Turnstile widget (bot protection on sign-up and sign-in)

1. In the dashboard: **Turnstile → Add widget**.
2. **Widget name:** anything, e.g. `bike-auction`.
3. **Hostnames:** `bike-auction.<your-subdomain>.workers.dev` (from 4.1). Add your custom domain too if you will
   use one.
4. **Widget mode:** Managed.
5. Create it, then copy the **Site key** (public) and the **Secret key** (keep it private).

The deploy script refuses to run without real keys. Cloudflare's always-pass test keys would let any bot
through. If you don't know your hostname yet, see _Deploying before you have Turnstile keys_ in section 9.

---

## 5. Log in Wrangler and deploy

### 5.1 Log Wrangler in (once per computer)

```bash
npx wrangler login      # opens your browser: click "Allow"
npx wrangler whoami     # should print your email and account id
```

Logging in on the Cloudflare website alone does **not** authenticate Wrangler; this command does.

If your login has access to several Cloudflare accounts, Wrangler asks which one to use. You can set
`CLOUDFLARE_ACCOUNT_ID` in your shell to skip the question.

### 5.2 Deploy

**macOS, Linux or PowerShell** (from the repository root):

```bash
node scripts/deploy.mjs --turnstile-site-key <SITE_KEY> --turnstile-secret-key <SECRET_KEY>
```

**Windows, no typing:** double-click **`deploy-windows.cmd`** in the repository folder. It installs dependencies,
asks for the two Turnstile keys (the secret is typed hidden) and runs the same script.

> Use `node scripts/deploy.mjs`, **not** `pnpm deploy`. In pnpm 10, `pnpm deploy` is a built-in pnpm command
> and does something else.

### 5.3 What the script does (all idempotent: safe to re-run)

| #   | Step           | Details                                                                                                                                                                                       |
| --- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Login check    | Runs `wrangler whoami`; opens `wrangler login` if needed                                                                                                                                      |
| 2   | D1             | Finds or creates the `bike-auction` database and reads its id                                                                                                                                 |
| 3   | KV             | Finds or creates the `bike-auction-photos` namespace and reads its id                                                                                                                         |
| 4   | Deploy config  | Writes `apps/worker/wrangler.deploy.jsonc` (git-ignored) from `wrangler.jsonc` with your real ids. Drops the R2 binding unless `--with-r2`. `wrangler.jsonc` itself is never changed          |
| 5   | Secrets        | Generates `BETTER_AUTH_SECRET`, `PSEUDONYM_SECRET` and `SEED_TOKEN` once and stores them, with your Turnstile keys, in `apps/worker/.deploy-secrets.json` (git-ignored) so re-runs reuse them |
| 6   | Build          | `pnpm build` (the React app into static assets, plus the Worker)                                                                                                                              |
| 7   | Migrations     | `wrangler d1 migrations apply DB --remote` (0001–0007; only new ones run)                                                                                                                     |
| 8   | Deploy         | `wrangler deploy` with `APP_VERSION=<git commit>`, your Turnstile site key and `DEMO_MODE=false`. Creates the Durable Object classes, cron triggers and bindings                              |
| 9   | Secrets upload | `wrangler secret bulk` (sent to Cloudflare, never printed)                                                                                                                                    |
| 10  | Health check   | Polls `https://…/api/v1/status` until it reports `ok` and the new version                                                                                                                     |

At the end it prints `✔ Deployed: https://bike-auction.<your-subdomain>.workers.dev`.

**Keep `apps/worker/.deploy-secrets.json` safe and never commit it.** It is git-ignored. If you lose it, the
next deploy generates new secrets: everyone is signed out, and bidder pseudonyms change for new events.

### 5.4 Deploy flags

| Flag                                             | Effect                                                                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--turnstile-site-key`, `--turnstile-secret-key` | Your real Turnstile keys (required for a normal deploy; remembered for later re-runs)                                                                                                                                          |
| `--test-turnstile`                               | Short-lived **verification** deploy with Cloudflare's always-pass test keys. Runs `scripts/auth-gate.mjs`: 20 register/login cycles to prove password hashing fits the free CPU limit. **Redeploy with real keys right after** |
| `--demo`                                         | Also seeds demo accounts and a small fictional catalogue, and shows one-click demo sign-in buttons. **Evaluation only:** the demo passwords are public                                                                         |
| `--with-r2`                                      | Also creates and binds the private R2 bucket for photos. R2 may require a payment method on your account; without this flag photos go to Workers KV                                                                            |
| `--skip-gate`                                    | Skip the 20× auth gate                                                                                                                                                                                                         |

---

## 6. Create your administrator

New accounts are always buyers. There is no admin sign-up page, on purpose. To make your first admin:

1. Open your site and click **Create an account**. Fill in your name, email, a password of at least 10
   characters and the consent box, then pass the Turnstile check.
2. Promote that account (run from `apps/worker`, replace the email):

   ```bash
   cd apps/worker
   npx wrangler d1 execute bike-auction --remote --command "UPDATE \"user\" SET role='ADMIN' WHERE email='you@example.com'"
   ```

   On Windows PowerShell, use single quotes outside and escaped double quotes inside:

   ```powershell
   npx wrangler d1 execute bike-auction --remote --command 'UPDATE "user" SET role=''ADMIN'' WHERE email=''you@example.com'''
   ```

3. Sign out and sign in again. **Auction desk** now appears in the menu.

Admins cannot bid (by design). For testing, register one or two more accounts as buyers.

---

## 7. Configure payments and options (optional)

Edit the `vars` in `apps/worker/wrangler.jsonc`, then re-run the deploy command (the keys are remembered, so
`node scripts/deploy.mjs` alone is enough):

| Var                         | Default             | Set it to                                                                                                             |
| --------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_UPI_ID`            | empty               | Your business UPI ID, shown to auction winners. Empty: "Our team will share the payment details"                      |
| `PAYMENT_BANK_DETAILS`      | empty               | Account name, number and IFSC, shown to winners                                                                       |
| `REQUIRE_DEPOSIT`           | `false`             | `true`: no bidding without a verified participation deposit                                                           |
| `BLOCK_BIDDING_WHILE_OWING` | `true`              | `false`: buyers may keep bidding while they owe a payment                                                             |
| `ALLOWED_ORIGINS`           | empty               | Extra origins allowed to call the API (only if you host the frontend elsewhere)                                       |
| `RETENTION_*`               | 365 d / 90 d / 24 h | How long security events, watchlists of ended auctions, login throttles, deletion records and orphan uploads are kept |

These are plain vars, visible in the config and the dashboard. Never put secrets in `vars`; secrets go through
the deploy script (`wrangler secret`).

Payment rules (25% within 24 hours, balance by day 15, defaults, deposits): [`settlement.md`](settlement.md).

---

## 8. Check that everything works (10 minutes)

1. **Status:** open `https://bike-auction.<your-subdomain>.workers.dev/api/v1/status`. It should show
   `"status":"ok"`, your git commit as `version`, and D1 `ok`.
2. **Accounts:** register a buyer in a normal browser. The Turnstile check must pass. Sign out and in again.
   In DevTools, the session cookie should be `Secure; HttpOnly`.
3. **Listing:** as admin, go to **Auction desk → Motorcycles → Add motorcycle**.
   1. Fill in the details and click **Save details**.
   2. **Save inspection**.
   3. Upload a photo with **Choose photos**.
   4. **Create draft auction**, starting in 1–2 minutes and closing about 10 minutes later.
   5. **Schedule auction**.
4. **Live bidding:** open the auction as two buyers in two browsers (one can be a private window). A bid in
   one appears in the other within about a second, without refreshing.
5. **Proxy bidding:** set a maximum as one buyer; a manual bid from the other is countered automatically.
6. **Close:** after the deadline, both buyers see the result. The winner's **Purchases** page shows
   "Pay 25% by …".
7. **Operations:** **Auction desk → Live ops** shows status ok and no warnings.
8. **Logs:** run `npx wrangler tail bike-auction` (from `apps/worker`) to watch structured JSON request logs
   live. You can also use the dashboard: **Workers & Pages → bike-auction → Logs**.

---

## 9. Troubleshooting

| Symptom                                                    | Cause and fix                                                                                                                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `You need to register a workers.dev subdomain`             | Do step 4.1, then re-run the deploy                                                                                                                            |
| Deploy fails mentioning **Analytics Engine**               | Enable it once (step 4.2), then re-run                                                                                                                         |
| `Real Turnstile keys are required`                         | Pass `--turnstile-site-key` and `--turnstile-secret-key` (step 4.3), or use `--test-turnstile` for a short verification deploy only                            |
| `pnpm deploy` does something strange                       | Use `node scripts/deploy.mjs` (step 5.2)                                                                                                                       |
| `Not logged in` / authentication errors                    | Run `npx wrangler login` in **your own terminal**, then `npx wrangler whoami`                                                                                  |
| Sign-up/sign-in says the bot check failed                  | The Turnstile widget's hostname must match your site's exact hostname (step 4.3). Embedded or automated browser panes can fail Turnstile; use a normal browser |
| Wrangler asked to edit `wrangler.jsonc` during `d1 create` | The script answers for you and restores the file; your real ids live only in the git-ignored `wrangler.deploy.jsonc`                                           |
| Health check timed out                                     | Open `/api/v1/status` yourself; a first deploy can take a minute to propagate. Re-running the script is safe                                                   |
| Photo upload fails (503)                                   | The `PHOTOS` KV binding is missing. Re-run the deploy script, which creates and binds it                                                                       |
| No **Auction desk** in the menu                            | Your account is still a buyer: do step 6, then sign out and back in                                                                                            |
| `Bid refused: Complete the payment for …`                  | That buyer won an earlier auction and owes a payment (settlement rule). Pay or verify as admin, or set `BLOCK_BIDDING_WHILE_OWING=false`                       |

**Deploying before you have Turnstile keys.** If you don't know your hostname yet, deploy once with
`node scripts/deploy.mjs --test-turnstile`. The script prints the URL. Create the Turnstile widget for that
hostname, then **redeploy at once** with the real keys. Never leave a site running on the test keys.

---

## 10. Updating, rolling back, custom domain and removal

**Update to a newer version of the code:**

```bash
git pull
pnpm install
node scripts/deploy.mjs          # keys and secrets are remembered
```

New D1 migrations are applied automatically and are additive, so existing data stays.

**Roll back the code:** run `npx wrangler rollback` from `apps/worker`, or go to Dashboard → Workers &
Pages → bike-auction → Deployments → roll back to the previous version.

**Restore data:** D1 Time Travel keeps the last 7 days on the free plan (30 on paid):

```bash
cd apps/worker
npx wrangler d1 time-travel info bike-auction
npx wrangler d1 time-travel restore bike-auction --timestamp <ISO time>
```

**Custom domain (optional):** Dashboard → Workers & Pages → bike-auction → Settings → Domains & Routes → Add →
Custom domain. Your domain must be on Cloudflare. Add the new hostname to the Turnstile widget too.

**Remove everything (to clean up a test account):**

```bash
cd apps/worker
npx wrangler delete bike-auction                       # Worker, its Durable Objects and cron triggers
npx wrangler d1 delete bike-auction                    # the database (irreversible)
npx wrangler kv namespace delete --namespace-id <id>   # the photos namespace (id from `wrangler kv namespace list`)
```

Then delete the Turnstile widget in the dashboard.

---

## 11. Security checklist for a real deployment

- Use real Turnstile keys; never leave `--test-turnstile` running.
- Don't use `--demo` on a site real people use: the demo passwords are public in this repository.
- Keep `apps/worker/.deploy-secrets.json` private. Never commit it, `.dev.vars`, or `wrangler.deploy.jsonc`;
  all three are git-ignored.
- Make admins only with the D1 command in step 6, and keep their number small.
- Check **Live ops** and the **Audit trail** regularly. All admin actions are logged with who, what and when.

More detail:

- [`DEPLOYMENT.md`](DEPLOYMENT.md): what was verified on Cloudflare, and the original deployment notes.
- [`runbook.md`](runbook.md): operating and incident procedures.
- [`architecture.md`](architecture.md): how the system works.
- [`threat-model.md`](threat-model.md): security design.
