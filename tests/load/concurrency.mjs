#!/usr/bin/env node
/**
 * Controlled concurrency, correctness and latency test against a LOCAL app (wrangler dev).
 * Never point this at a live free-tier deployment.
 *
 *   node tests/load/concurrency.mjs http://127.0.0.1:8800 [out.json]
 *
 * Needs: demo accounts seeded (pnpm --filter @bike/worker seed:local) and a server started with
 * `--var TURNSTILE_SECRET_KEY:` (captcha off; development only) so test buyers can register.
 *
 * Scenarios (all verified against the authoritative state, not the client's view):
 *   A. 20 buyers, 50 simultaneous bids at the SAME amount → exactly one accepted.
 *   B. 100 simultaneous bids with mixed amounts → accepted amounts strictly increase, no gaps.
 *   C. Simultaneous proxy maxima (two EQUAL) + manual bids → earlier equal max wins, no step above a max.
 *   D. 5 auctions × 20 simultaneous bids, all at once → each auction consistent, no cross-talk.
 *   E. Duplicate requests: one Idempotency-Key sent 10× concurrently → one effect, identical replays.
 *   F. Bids racing the deadline (soft close OFF) → nothing accepted after the close.
 *   G. Soft close ON: late bids extend, every extension stays ≤ original close + 30 min.
 * Measurements: bid latency (p50/p95), WebSocket delivery delay, catalogue/detail API latency,
 * D1 projection delay.
 */
/* global process, setTimeout, console, performance, fetch, crypto, WebSocket */
import { writeFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8800";
const OUT = process.argv[3];
const API = `${BASE}/api/v1`;
const ORIGIN = BASE;
const RUN = Date.now().toString(36);
const NOTICE = { accepted: true, version: "2026-10-13" };
const report = {
  base: BASE,
  startedAt: new Date().toISOString(),
  scenarios: {},
  latency: {},
  failures: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10
    : null;
};
const stats = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: pct(xs, 100) });
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) report.failures.push({ name, detail });
}

async function req(method, path, { cookie, body, key } = {}) {
  const headers = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key) headers["idempotency-key"] = key;
  const t0 = performance.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ms = performance.now() - t0;
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null; // not JSON (e.g. an empty 204)
  }
  return { status: res.status, json, ms, headers: res.headers };
}
const cookieOf = (res) =>
  (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

async function signIn(email, password) {
  const r = await req("POST", "/auth/sign-in/email", { body: { email, password } });
  if (r.status !== 200) throw new Error(`sign-in ${email}: ${r.status}`);
  return cookieOf(r);
}
async function signUp(i) {
  const email = `load.${RUN}.${i}@example.test`;
  for (;;) {
    const r = await req("POST", "/auth/sign-up/email", {
      body: { name: `Load Buyer ${i}`, email, password: `Lb!${RUN}x${i}Qz9#mT`, consent: NOTICE },
    });
    if (r.status === 200) return cookieOf(r);
    if (r.status === 429) {
      await sleep(5000);
      continue;
    } // the per-IP auth limit (20/min) is doing its job
    throw new Error(`sign-up ${i}: ${r.status} ${JSON.stringify(r.json)}`);
  }
}

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
async function createAuction(
  admin,
  label,
  { closesInMs, antiSniping = true, startRupees = 50_000, reserve = null },
) {
  const bike = await req("POST", "/admin/bikes", {
    cookie: admin,
    body: {
      make: "Hero",
      model: `${label} ${RUN}`,
      variant: "Load",
      manufactureYear: 2022,
      registrationYear: 2022,
      fuel: "PETROL",
      engineCc: 125,
      kmDriven: 9000,
      ownerCount: 1,
      rtoCode: "mh-12",
      rcStatus: "ORIGINAL",
      hypothecation: "NONE",
      insuranceValidTill: null,
      city: "Pune",
      yard: "Load yard",
      repossessed: false,
      asIsWhereIs: true,
      colour: null,
      description: "Load-test listing. Fictional.",
    },
  });
  if (bike.status !== 201 && bike.status !== 200)
    throw new Error(`bike: ${bike.status} ${JSON.stringify(bike.json)}`);
  const sections = Object.fromEntries(
    [
      "engine",
      "transmission",
      "electricals",
      "battery",
      "brakes",
      "tyres",
      "suspension",
      "frame",
      "body",
    ].map((k) => [k, { condition: "GOOD", note: "" }]),
  );
  await req("PUT", `/admin/bikes/${bike.json.id}/inspection`, {
    cookie: admin,
    body: {
      grade: "B",
      sections,
      visibleDamage: "",
      mechanicalIssues: "",
      inspectorNotes: "",
      inspectorName: "Load",
      inspectedAt: "2026-10-01",
    },
  });
  const a = await req("POST", "/admin/auctions", {
    cookie: admin,
    body: {
      bikeId: bike.json.id,
      startPriceMinor: startRupees * 100,
      reserveMinor: reserve,
      startsAt: iso(-61_000),
      closesAt: iso(closesInMs),
      antiSniping,
      schedule: true,
      terms: "Load test.",
    },
  });
  if (a.status !== 201) throw new Error(`auction: ${a.status} ${JSON.stringify(a.json)}`);
  return a.json.view.auctionId;
}

const bidLatencies = [];
async function bid(cookie, id, amountMinor, key = `k${crypto.randomUUID().replaceAll("-", "")}`) {
  const r = await req("POST", `/auctions/${id}/bids`, { cookie, body: { amountMinor }, key });
  bidLatencies.push(r.ms);
  return r;
}
async function setMax(cookie, id, maxMinor) {
  const r = await req("PUT", `/auctions/${id}/max-bid`, {
    cookie,
    body: { maxMinor },
    key: `m${crypto.randomUUID().replaceAll("-", "")}`,
  });
  bidLatencies.push(r.ms);
  return r;
}
async function ledger(admin, id) {
  const rows = [];
  let before;
  for (;;) {
    const r = await req(
      "GET",
      `/admin/auctions/${id}/ledger?limit=100${before ? `&beforeSeq=${before}` : ""}`,
      { cookie: admin },
    );
    rows.push(...r.json.items);
    if (!r.json.nextBeforeSeq) break;
    before = r.json.nextBeforeSeq;
  }
  return rows.sort((a, b) => a.seq - b.seq);
}
const view = async (id, cookie) => (await req("GET", `/auctions/${id}`, { cookie })).json;

/** Invariants that must hold for any auction after any interleaving. */
async function verifyAuction(name, admin, id, { maxima = {} } = {}) {
  const rows = await ledger(admin, id);
  const v = await view(id);
  const amounts = rows.map((r) => r.amountMinor);
  const increasing = amounts.every((a, i) => i === 0 || a > amounts[i - 1]);
  const seqs = rows.map((r) => r.seq);
  const uniqueSeq = new Set(seqs).size === seqs.length;
  const uniqueBidIds = new Set(rows.map((r) => r.bidId)).size === rows.length;
  check(`${name}: ledger prices strictly increase (${rows.length} bids)`, increasing);
  check(`${name}: no duplicated bids (unique seq and bidId)`, uniqueSeq && uniqueBidIds);
  check(
    `${name}: view agrees with ledger`,
    v.bidCount === rows.length && (rows.length === 0 || v.currentPriceMinor === amounts.at(-1)),
    `view ${v.bidCount}/${v.currentPriceMinor} vs ledger ${rows.length}/${amounts.at(-1)}`,
  );
  for (const [bidder, max] of Object.entries(maxima)) {
    const over = rows.filter(
      (r) => r.bidder === bidder && r.kind === "PROXY" && r.amountMinor > max,
    );
    check(`${name}: no automatic bid above ${bidder}'s maximum`, over.length === 0);
  }
  return { rows, view: v };
}

async function main() {
  console.log(`Concurrency test against ${BASE} (run ${RUN})`);
  const admin = await signIn("admin@bikeauction.demo", "Demo-Admin-2026!");
  const buyers = [
    await signIn("buyer.a@bikeauction.demo", "Demo-BuyerA-2026!"),
    await signIn("buyer.b@bikeauction.demo", "Demo-BuyerB-2026!"),
  ];
  const t0 = Date.now();
  for (let i = buyers.length; i < 20; i++) buyers.push(await signUp(i));
  console.log(
    `20 buyers ready (${((Date.now() - t0) / 1000).toFixed(0)} s, incl. auth rate-limit waits)`,
  );
  // Each buyer's pseudonym per auction is learned from GET /auctions/:id/bids (isYou), only for checks.

  // ---- A: 50 simultaneous bids at the same amount ----
  {
    const id = await createAuction(admin, "Same-amount", { closesInMs: 3_600_000 });
    const start = (await view(id)).minNextBidMinor;
    const res = await Promise.all(
      Array.from({ length: 50 }, (_, i) => bid(buyers[i % 20], id, start)),
    );
    const accepted = res.filter((r) => r.status === 201).length;
    const tooLow = res.filter((r) => r.json?.code === "BID_TOO_LOW").length;
    check(
      "A: 50 simultaneous equal bids → exactly 1 accepted",
      accepted === 1,
      `${accepted} accepted, ${tooLow} BID_TOO_LOW, others ${50 - accepted - tooLow}`,
    );
    const { rows } = await verifyAuction("A", admin, id);
    report.scenarios.A = { requests: 50, accepted, tooLow, ledgerBids: rows.length };
  }

  // ---- B: 100 simultaneous bids, mixed amounts ----
  {
    const id = await createAuction(admin, "Mixed", { closesInMs: 3_600_000 });
    const res = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        bid(buyers[i % 20], id, 5_000_000 + 50_000 * ((i * 37) % 60)),
      ),
    );
    const codes = {};
    for (const r of res)
      codes[r.status === 201 ? "201" : (r.json?.code ?? r.status)] =
        (codes[r.status === 201 ? "201" : (r.json?.code ?? r.status)] ?? 0) + 1;
    const { rows } = await verifyAuction("B", admin, id);
    const accepted201 = codes["201"] ?? 0;
    check(
      "B: every 201 corresponds to exactly one ledger bid",
      accepted201 === rows.length,
      `${accepted201} × 201 vs ${rows.length} ledger bids`,
    );
    report.scenarios.B = { requests: 100, outcomes: codes, ledgerBids: rows.length };
  }

  // ---- C1: equal maxima → the earlier one wins at exactly that amount ----
  {
    const id = await createAuction(admin, "ProxyTie", { closesInMs: 3_600_000 });
    const eq1 = await setMax(buyers[0], id, 8_000_000);
    const eq2 = await setMax(buyers[1], id, 8_000_000);
    const v = await view(id);
    const first = await view(id, buyers[0]);
    check("C1: equal maxima → the EARLIER one leads", first.viewer?.isLeading === true);
    check(
      "C1: …at exactly the shared maximum (₹80,000)",
      v.currentPriceMinor === 8_000_000,
      `price ${v.currentPriceMinor}`,
    );
    await verifyAuction("C1", admin, id);
    report.scenarios.C1 = { statuses: [eq1.status, eq2.status], finalPrice: v.currentPriceMinor };
  }

  // ---- C2: 8 maxima + 10 manual bids, all simultaneous ----
  {
    const id = await createAuction(admin, "ProxyBurst", { closesInMs: 3_600_000 });
    const res = await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => setMax(buyers[2 + i], id, 6_000_000 + 100_000 * i)), // ₹60k…₹67k
      ...Array.from({ length: 10 }, (_, i) => bid(buyers[10 + i], id, 5_000_000 + 50_000 * i)), // ₹50k…₹54.5k
    ]);
    const pseud = {};
    for (const [i, c] of buyers.entries()) {
      const mine = (
        await req("GET", `/auctions/${id}/bids?limit=100`, { cookie: c })
      ).json.items.find((b) => b.isYou);
      if (mine) pseud[i] = mine.bidder;
    }
    const maxima = {};
    for (let i = 0; i < 8; i++) if (pseud[2 + i]) maxima[pseud[2 + i]] = 6_000_000 + 100_000 * i;
    const { view: v } = await verifyAuction("C2", admin, id, { maxima });
    const top = await view(id, buyers[9]);
    check(
      "C2: the highest maximum (₹67,000) leads",
      top.viewer?.isLeading === true,
      `leader ${v.leadingBidder}`,
    );
    check(
      "C2: price = second-highest max + increment (₹66,500)",
      v.currentPriceMinor === 6_650_000,
      `price ${v.currentPriceMinor}`,
    );
    report.scenarios.C2 = {
      requests: 18,
      outcomes: res.map((r) => r.status).reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {}),
      finalPrice: v.currentPriceMinor,
      ledgerBids: v.bidCount,
    };
  }

  // ---- D: 5 auctions × 20 simultaneous bids ----
  {
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createAuction(admin, `Multi${i}`, { closesInMs: 3_600_000 }),
      ),
    );
    await Promise.all(
      ids.flatMap((id, a) =>
        Array.from({ length: 20 }, (_, i) =>
          bid(buyers[i], id, 5_000_000 + 50_000 * ((i * 7 + a) % 20)),
        ),
      ),
    );
    const counts = [];
    for (const [a, id] of ids.entries())
      counts.push((await verifyAuction(`D${a}`, admin, id)).rows.length);
    report.scenarios.D = { auctions: 5, requests: 100, ledgerBidsPerAuction: counts };
  }

  // ---- E: duplicate requests ----
  {
    const id = await createAuction(admin, "Dupes", { closesInMs: 3_600_000 });
    const key = `dup${RUN}${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 64);
    const res = await Promise.all(
      Array.from({ length: 10 }, () => bid(buyers[3], id, 5_000_000, key)),
    );
    const ok = res.filter((r) => r.status === 201);
    const sameBid = new Set(ok.map((r) => r.json.bidId)).size === 1;
    const replayed = res.filter((r) => r.headers.get("idempotent-replayed") === "true").length;
    const { rows } = await verifyAuction("E", admin, id);
    check(
      "E: one key sent 10× concurrently → exactly one bid",
      rows.length === 1 && sameBid,
      `${rows.length} bid(s), ${ok.length} × 201, ${replayed} replayed`,
    );
    report.scenarios.E = {
      requests: 10,
      ledgerBids: rows.length,
      responses201: ok.length,
      replayed,
    };
  }

  // ---- F: bids racing the deadline (soft close off) ----
  {
    const id = await createAuction(admin, "Deadline", { closesInMs: 65_000, antiSniping: false });
    const closesAt = (await view(id)).closesAt;
    while (Date.now() < closesAt - 1500) await sleep(200);
    const sent = [];
    while (Date.now() < closesAt + 1500) {
      const v = await view(id);
      const min = v.minNextBidMinor ?? 5_000_000;
      sent.push(
        ...(await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            bid(buyers[(i + sent.length) % 20], id, min + 50_000 * i),
          ),
        )),
      );
    }
    await sleep(2500);
    const { rows, view: v } = await verifyAuction("F", admin, id);
    const late = rows.filter((r) => r.at >= closesAt);
    check(
      "F: no bid accepted at or after the close",
      late.length === 0,
      `${late.length} late of ${rows.length}`,
    );
    check("F: auction ended by the server", v.status === "ENDED", v.status);
    const winner = rows.at(-1);
    check(
      "F: winner is the highest bid",
      !winner || (v.outcome === "SOLD" && v.leadingBidder === winner.bidder),
      `${v.outcome} ${v.leadingBidder}`,
    );
    report.scenarios.F = {
      requests: sent.length,
      accepted: rows.length,
      afterClose: late.length,
      outcome: v.outcome,
    };
  }

  // ---- G: soft close extensions stay within the hard cap ----
  {
    const id = await createAuction(admin, "SoftClose", { closesInMs: 70_000, antiSniping: true });
    const original = (await view(id)).closesAt;
    const hardCap = original + 30 * 60_000;
    let extensions = 0;
    for (let round = 0; round < 6; round++) {
      const v = await view(id);
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          bid(buyers[(round * 5 + i) % 20], id, (v.minNextBidMinor ?? 5_000_000) + 50_000 * i),
        ),
      );
      const after = await view(id);
      if (after.closesAt > v.closesAt) extensions++;
      check(`G: round ${round + 1}: closesAt ≤ hard cap`, after.closesAt <= hardCap);
    }
    const v = await view(id);
    check(
      "G: late bids extended the deadline",
      v.extensionCount > 0,
      `${v.extensionCount} extension(s)`,
    );
    await verifyAuction("G", admin, id);
    report.scenarios.G = {
      roundsThatExtended: extensions,
      extensionCount: v.extensionCount,
      closesAtMinusOriginalMs: v.closesAt - original,
      hardCapMs: 30 * 60_000,
    };
  }

  // ---- Measurements ----
  report.latency.bidRoundTripUnderBurstsMs = stats(bidLatencies); // includes queueing in 50–100-request bursts
  {
    // WebSocket delivery: a listener on auction W; sequential bids; time from POST start → event.
    const id = await createAuction(admin, "WsTiming", { closesInMs: 3_600_000 });
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/v1/auctions/${id}/stream`, {
      headers: { origin: ORIGIN },
    });
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "bid.accepted" && pending.has(m.amountMinor))
        pending.get(m.amountMinor)(performance.now());
    };
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    await sleep(300);
    const delays = [];
    const single = [];
    await sleep(11_000); // let the per-user bid limits from the bursts above reset
    for (let i = 0; i < 30; i++) {
      const amount = (await view(id)).minNextBidMinor;
      const got = new Promise((r) => pending.set(amount, r));
      const t0 = performance.now();
      const r = await bid(buyers[i % 20], id, amount);
      if (r.status === 201) {
        single.push(r.ms);
        delays.push((await got) - t0);
      }
    }
    ws.close();
    report.latency.bidRoundTripSequentialMs = stats(single);
    report.latency.wsDeliveryFromBidStartMs = stats(delays);

    // D1 projection delay: bid → the D1 catalogue shows the new price.
    const syncDelays = [];
    for (let i = 0; i < 10; i++) {
      const amount = (await view(id)).minNextBidMinor;
      const t0 = performance.now();
      const r = await bid(buyers[(i + 5) % 20], id, amount);
      if (r.status !== 201) continue;
      for (;;) {
        const list = (
          await req("GET", `/auctions?status=LIVE&limit=48&q=${encodeURIComponent("WsTiming")}`)
        ).json;
        if (list.items.some((c) => c.auctionId === id && c.currentPriceMinor === amount)) break;
        await sleep(10);
      }
      syncDelays.push(performance.now() - t0);
    }
    report.latency.d1ProjectionDelayMs = stats(syncDelays);

    const cat = [],
      det = [],
      live = [];
    for (let i = 0; i < 40; i++) {
      cat.push((await req("GET", "/auctions?limit=12")).ms);
      det.push((await req("GET", `/auctions/${id}/details`)).ms);
      live.push((await req("GET", `/auctions/${id}`)).ms);
    }
    report.latency.catalogueListMs = stats(cat);
    report.latency.detailsMs = stats(det);
    report.latency.liveViewMs = stats(live);
  }

  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report.latency, null, 2));
  console.log(
    report.failures.length === 0
      ? "CONCURRENCY TEST PASSED"
      : `FAILED: ${report.failures.length} check(s)`,
  );
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.exit(report.failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
