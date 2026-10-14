"""
Day-6 multi-user live auction test against a REAL local app (wrangler dev + local D1/DO), Chromium.

Three independent authenticated browser contexts: Buyer A (desktop), Buyer B (mobile), Admin.
Covers: live price propagation, outbid notice to the right user, anti-sniping deadline change seen
by everyone, consistency across all three sessions, refresh, offline → recovery, a real server
restart → automatic recovery, no duplicate bids in history after reconnects, simultaneous bids,
authoritative close with the correct result, and an expired session.

This script starts and restarts `wrangler dev` itself (so it can kill the server mid-test).
Usage: python tests/e2e/live.py [port] [screenshot_dir]
Needs: Playwright for Python; local state seeded with the demo accounts (pnpm --filter @bike/worker seed:local).
"""
import json, os, re, signal, subprocess, sys, time, urllib.request
from datetime import datetime, timedelta, timezone
from playwright.sync_api import expect, sync_playwright

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/e2e-live"
BASE = f"http://127.0.0.1:{PORT}"
WORKER = os.path.join(os.path.dirname(__file__), "..", "..", "apps", "worker")
os.makedirs(OUT, exist_ok=True)
NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))
TAG = f"L{int(time.time()) % 100000}"
server = None
# This sandbox cannot reach challenges.cloudflare.com (DNS), so local e2e runs blank the Turnstile secret:
# the Worker then skips captcha ONLY because ENVIRONMENT=development (it refuses to start without a secret
# anywhere else; see apps/worker/src/auth/auth.ts). Set E2E_TURNSTILE=1 to keep it on where reachable.
CAPTCHA_OFF = [] if os.environ.get("E2E_TURNSTILE") == "1" else ["--var", "TURNSTILE_SECRET_KEY:"]


def step(msg): print(f"✓ {msg}", flush=True)


def start_server():
    global server
    env = {**os.environ, "NO_PROXY": "*", "no_proxy": "*"}
    log = open(f"{OUT}/wrangler.log", "a")
    server = subprocess.Popen(["npx", "wrangler", "dev", "--port", str(PORT), "--ip", "127.0.0.1", *CAPTCHA_OFF],
                              cwd=WORKER, stdout=log, stderr=log, env=env, start_new_session=True)
    for _ in range(120):
        try:
            if NOPROXY.open(f"{BASE}/api/v1/health", timeout=2).status == 200: return
        except Exception: pass
        time.sleep(0.5)
    raise RuntimeError("wrangler dev did not start")


def stop_server():
    if server and server.poll() is None:
        os.killpg(server.pid, signal.SIGTERM)
        try: server.wait(10)
        except subprocess.TimeoutExpired: os.killpg(server.pid, signal.SIGKILL)


def login(page, who):
    page.goto(f"{BASE}/login")
    page.get_by_role("button", name=who).click()
    page.get_by_role("button", name="Sign in", exact=True).last.click()
    page.wait_for_url(lambda u: "/login" not in u, timeout=15000)


def api(page, method, path, body=None):
    r = page.request.fetch(f"{BASE}/api/v1{path}", method=method, headers={"origin": BASE, "content-type": "application/json"},
                           data=json.dumps(body) if body is not None else None)
    assert r.ok, (path, r.status, r.text())
    return r.json()


def iso(ms): return datetime.fromtimestamp(time.time() + ms / 1000, timezone.utc).isoformat()


def create_live_auction(admin_page, model, closes_in_ms, anti_sniping, start_rupees):
    bike = api(admin_page, "POST", "/admin/bikes", {
        "make": "Bajaj", "model": model, "variant": "E2E", "manufactureYear": 2022, "registrationYear": 2022,
        "fuel": "PETROL", "engineCc": 199, "kmDriven": 12000, "ownerCount": 1, "rtoCode": "ka-01",
        "rcStatus": "ORIGINAL", "hypothecation": "NONE", "insuranceValidTill": None, "city": "Bengaluru",
        "yard": "Peenya yard", "repossessed": False, "asIsWhereIs": True, "colour": None,
        "description": "E2E live test listing. Fictional."})
    api(admin_page, "PUT", f"/admin/bikes/{bike['id']}/inspection", {
        "grade": "B", "sections": {k: {"condition": "GOOD", "note": ""} for k in
                                   ["engine", "transmission", "electricals", "battery", "brakes", "tyres", "suspension", "frame", "body"]},
        "visibleDamage": "", "mechanicalIssues": "", "inspectorNotes": "E2E", "inspectorName": "E2E", "inspectedAt": "2026-10-01"})
    a = api(admin_page, "POST", "/admin/auctions", {
        "bikeId": bike["id"], "startPriceMinor": start_rupees * 100, "reserveMinor": None,
        "startsAt": iso(-61_000), "closesAt": iso(closes_in_ms), "antiSniping": anti_sniping, "schedule": True,
        "terms": "E2E test auction."})
    return a["view"]["auctionId"]


def conn(page): return page.locator("[data-conn]").get_attribute("data-conn")
def live_ok(page, t=20000): expect(page.locator('[data-conn="live"]')).to_be_visible(timeout=t)
def closes_ms(page): return int(page.get_by_test_id("closes").get_attribute("data-ms"))
def text(page, tid): return page.get_by_test_id(tid).inner_text().strip()


def bid(page, amount):
    page.locator("#bid-amount").fill(str(amount))
    page.get_by_role("button", name=re.compile("^Place bid")).click()


def history_seqs(page):
    return [int(x) for x in page.locator("[data-testid=bid-history] li").evaluate_all("els => els.map(e => e.dataset.seq)")]


try:
    start_server(); step(f"wrangler dev started on :{PORT}")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx_admin = browser.new_context(viewport={"width": 1366, "height": 900})
        ctx_a = browser.new_context(viewport={"width": 1366, "height": 900})
        ctx_b = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
                                    user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile")
        admin, A, B = ctx_admin.new_page(), ctx_a.new_page(), ctx_b.new_page()
        login(admin, "Admin"); login(A, "Buyer A"); login(B, "Buyer B"); step("three independent sessions signed in")

        auc = create_live_auction(admin, f"Pulsar {TAG}", 100_000, True, 50000)
        url = f"{BASE}/auctions/{auc}"
        A.goto(url); B.goto(url)
        live_ok(A); live_ok(B); step("buyer A (desktop) and buyer B (mobile) on the same live auction")
        closes0 = closes_ms(B)

        # 1. A bids → B sees it without refreshing; anti-sniping moves the deadline for everyone.
        bid(A, 50000)
        expect(A.get_by_test_id("bid-confirmed")).to_be_visible(timeout=10000)
        expect(A.get_by_test_id("leading")).to_be_visible(timeout=10000)
        expect(B.get_by_test_id("price")).to_have_text("₹50,000", timeout=10000)
        expect(B.get_by_test_id("bid-count")).to_have_text("1")
        expect(B.get_by_test_id("extended")).to_be_visible(timeout=10000)
        assert closes_ms(B) > closes0 and closes_ms(A) == closes_ms(B), "deadline not extended for all"
        step("A bid ₹50,000 → B saw price, count and the anti-sniping deadline update live")

        # 2. B bids higher → A gets the outbid notice; B leads. Nobody's identity is exposed.
        bid(B, 50500)
        expect(B.get_by_test_id("leading")).to_be_visible(timeout=10000)
        expect(A.get_by_test_id("outbid")).to_be_visible(timeout=10000)
        expect(A.get_by_test_id("leading")).to_have_count(0)
        expect(B.get_by_test_id("outbid")).to_have_count(0)
        assert "buyer.b@" not in A.content() and "buyer.a@" not in B.content(), "other buyer's identity leaked"
        step("B bid ₹50,500 → A was told they were outbid (only A); B shows 'You're leading'")

        # 3. Everyone (incl. admin) agrees; refresh keeps it.
        admin.goto(url); live_ok(admin)
        for pg in (A, B, admin):
            expect(pg.get_by_test_id("price")).to_have_text("₹50,500", timeout=10000)
            expect(pg.get_by_test_id("bid-count")).to_have_text("2")
        assert closes_ms(A) == closes_ms(B) == closes_ms(admin)
        expect(admin.get_by_text("Administrators can't bid.")).to_be_visible()
        A.reload(); B.reload(); live_ok(A); live_ok(B)
        expect(B.get_by_test_id("leading")).to_be_visible(timeout=10000)
        expect(A.get_by_test_id("price")).to_have_text("₹50,500")
        step("A, B and admin show the same price, count and deadline; refresh preserved it")
        A.screenshot(path=f"{OUT}/detail-desktop-live.png", full_page=True)
        B.screenshot(path=f"{OUT}/detail-mobile-live.png", full_page=False)

        # 4. B goes offline; A bids; B comes back and catches up (no duplicates).
        ctx_b.set_offline(True)
        expect(B.locator('[data-conn="offline"]')).to_be_visible(timeout=10000)
        expect(B.get_by_text("(may be outdated)")).to_be_visible()
        expect(B.get_by_test_id("leading-unconfirmed")).to_be_visible()  # never a confirmed "leading" while stale
        expect(B.get_by_test_id("leading")).to_have_count(0)
        bid(A, 51000)
        expect(A.get_by_test_id("leading")).to_be_visible(timeout=10000)
        B.screenshot(path=f"{OUT}/detail-mobile-offline.png", full_page=False)
        ctx_b.set_offline(False)
        live_ok(B)
        expect(B.get_by_test_id("price")).to_have_text("₹51,000", timeout=10000)
        expect(B.get_by_test_id("outbid")).to_be_visible(timeout=10000)
        expect(B.get_by_test_id("bid-count")).to_have_text("3")
        expect(B.locator("[data-testid=bid-history] li")).to_have_count(3, timeout=10000)
        seqs = history_seqs(B); assert len(seqs) == len(set(seqs)) == 3 and seqs == sorted(seqs, reverse=True), seqs
        step("B offline → 'Offline' + stale marker; back online → caught up to ₹51,000, outbid shown, 3 unique bids")

        # 5. Real server restart: both reconnect by themselves; then live events flow again.
        stop_server()
        expect(A.locator('[data-conn="reconnecting"], [data-conn="failed"]')).to_be_visible(timeout=60000)
        expect(B.locator('[data-conn="reconnecting"], [data-conn="failed"]')).to_be_visible(timeout=60000)
        A.screenshot(path=f"{OUT}/detail-desktop-reconnecting.png", full_page=False)
        start_server()
        live_ok(A, 60000); live_ok(B, 60000)
        expect(A.get_by_test_id("price")).to_have_text("₹51,000")
        bid(B, 51500)
        expect(A.get_by_test_id("price")).to_have_text("₹51,500", timeout=10000)
        expect(A.get_by_test_id("outbid")).to_be_visible(timeout=10000)
        expect(A.locator("[data-testid=bid-history] li")).to_have_count(4, timeout=10000)
        seqs = history_seqs(A); assert len(seqs) == len(set(seqs)) == 4, seqs
        step("server killed and restarted → both reconnected automatically; next bid arrived; no duplicate events")

        # 6. Leaving the page closes the socket; coming back works (tab/route switching cleanup).
        A.goto(f"{BASE}/auctions"); A.wait_for_timeout(500); A.go_back(); live_ok(A)
        expect(A.get_by_test_id("price")).to_have_text("₹51,500")
        step("navigated away and back: fresh connection, same state")

        # 7. Expired session: the bid is refused and the user is asked to sign in again.
        ctx_a.clear_cookies()
        bid(A, 52000)
        expect(A.get_by_text("Your session has expired. Sign in again to bid.")).to_be_visible(timeout=10000)
        expect(A.get_by_role("link", name="Sign in to bid")).to_be_visible()
        expect(B.get_by_test_id("price")).to_have_text("₹51,500")
        login(A, "Buyer A"); step("expired session: bid refused (401), clear message, nothing placed")

        # 8. Simultaneous bids + authoritative close.
        auc2 = create_live_auction(admin, f"Dominar {TAG}", 40_000, False, 40000)
        url2 = f"{BASE}/auctions/{auc2}"
        A.goto(url2); B.goto(url2); live_ok(A); live_ok(B)
        A.locator("#bid-amount").fill("40000"); B.locator("#bid-amount").fill("40000")
        # Hold both bid requests at the browser until both are issued, then release them together:
        # truly simultaneous (no live update can refill B's input between the two clicks).
        held = []
        hold = lambda route: held.append(route) if route.request.method == "POST" else route.continue_()
        for pg in (A, B): pg.route("**/api/v1/auctions/*/bids", hold)
        A.get_by_role("button", name=re.compile("^Place bid")).click(no_wait_after=True)
        B.get_by_role("button", name=re.compile("^Place bid")).click(no_wait_after=True)
        for _ in range(100):
            if len(held) == 2: break
            A.wait_for_timeout(50)
        assert len(held) == 2, f"expected 2 held bid requests, got {len(held)}"
        for r in held: r.continue_()
        for pg in (A, B): pg.unroute("**/api/v1/auctions/*/bids")
        expect(A.get_by_test_id("bid-count")).to_have_text("1", timeout=10000)
        expect(B.get_by_test_id("bid-count")).to_have_text("1", timeout=10000)
        a_leads = A.get_by_test_id("leading").count() == 1
        b_leads = B.get_by_test_id("leading").count() == 1
        assert a_leads != b_leads, "exactly one of the simultaneous bids must win"
        loser = B if a_leads else A
        # BLUEPRINT §11.5 copy; the minimum comes from the BID_TOO_LOW problem extension and refills the input.
        try:
            expect(loser.get_by_text("Someone just bid. Minimum is now ₹40,500.")).to_be_visible(timeout=10000)
        except AssertionError:
            print("DEBUG loser panel:", loser.locator("#live-panel").inner_text()[:1500])
            raise
        expect(loser.locator("#bid-amount")).to_have_value("40500")
        step(f"simultaneous ₹40,000 bids: exactly one accepted ({'A' if a_leads else 'B'}), the other told clearly")
        winner = A if a_leads else B
        expect(winner.get_by_test_id("result")).to_be_visible(timeout=70000)
        for pg in (A, B):
            expect(pg.get_by_test_id("result")).to_be_visible(timeout=15000)
            expect(pg.locator("#bid-amount")).to_have_count(0)
            assert "-" not in text(pg, "countdown"), text(pg, "countdown")
        expect(winner.get_by_test_id("result")).to_have_text("You won at ₹40,000. Our team will contact you.")
        expect(loser.get_by_test_id("result")).to_contain_text("Sold to Bidder ")
        step("auction closed by the server: SOLD shown to both, winner told, bidding disabled, no negative countdown")
        loser.screenshot(path=f"{OUT}/detail-{'mobile' if loser is B else 'desktop'}-ended.png", full_page=False)

        # 9. Proxy (automatic) bidding, watchlist and My Bids, across the two buyers.
        auc3 = create_live_auction(admin, f"Avenger {TAG}", 3_600_000, True, 50000)
        url3 = f"{BASE}/auctions/{auc3}"
        A.goto(url3); B.goto(url3); live_ok(A); live_ok(B)
        B.get_by_text("Auto-bid: set a maximum").click()
        B.locator("#proxy-max").fill("60000")
        B.get_by_role("button", name="Set maximum").click()
        expect(B.get_by_test_id("my-max")).to_contain_text("₹60,000", timeout=10000)
        expect(B.get_by_test_id("leading")).to_be_visible(timeout=10000)  # opening bid placed for B
        expect(A.get_by_test_id("price")).to_have_text("₹50,000", timeout=10000)
        bid(A, 50500)  # below B's hidden max → B's proxy answers in the same commit
        expect(A.get_by_test_id("price")).to_have_text("₹51,000", timeout=10000)
        expect(A.get_by_test_id("outbid")).to_be_visible(timeout=10000)
        expect(B.get_by_test_id("price")).to_have_text("₹51,000", timeout=10000)
        expect(B.get_by_test_id("leading")).to_be_visible()
        expect(B.get_by_test_id("outbid")).to_have_count(0)  # no false outbid while the proxy defends
        assert "60,000" not in A.content() and "6000000" not in A.content(), "B's hidden max leaked to A"
        step("B's auto-bid (max ₹60,000) defended against A's ₹50,500 → ₹51,000; max hidden from A")
        A.get_by_text("Auto-bid: set a maximum").click()
        A.locator("#proxy-max").fill("70000")
        A.get_by_role("button", name="Set maximum").click()
        expect(A.get_by_test_id("leading")).to_be_visible(timeout=10000)
        expect(A.get_by_test_id("price")).to_have_text("₹60,500", timeout=10000)  # B's max + one step
        expect(B.get_by_test_id("outbid")).to_be_visible(timeout=10000)
        expect(B.get_by_test_id("price")).to_have_text("₹60,500")
        assert "70,000" not in B.content(), "A's hidden max leaked to B"
        step("A's higher max (₹70,000) won at ₹60,500 = B's max + increment; B told they were outbid")
        A.get_by_role("button", name="Watch").first.click()
        expect(A.get_by_role("button", name="Watching").first).to_be_visible(timeout=10000)
        A.goto(f"{BASE}/me/watchlist")
        expect(A.get_by_text(f"Avenger {TAG}").first).to_be_visible(timeout=10000)
        A.goto(f"{BASE}/me/bids")
        expect(A.get_by_text(f"Avenger {TAG}").first).to_be_visible(timeout=10000)
        B.goto(f"{BASE}/me/bids?tab=outbid")
        expect(B.get_by_text(f"Avenger {TAG}").first).to_be_visible(timeout=10000)
        A.screenshot(path=f"{OUT}/my-bids-desktop.png", full_page=True)
        B.screenshot(path=f"{OUT}/my-bids-mobile-outbid.png", full_page=False)
        step("watchlist and My Bids (Leading for A, Outbid for B) reflect the live auction")
        A.goto(url3); live_ok(A)
        A.screenshot(path=f"{OUT}/detail-desktop-proxy.png", full_page=False)

        # Mobile layout check: price, countdown and bid button visible without scrolling far; sticky bar.
        B.goto(url); live_ok(B)
        box = B.get_by_test_id("price").bounding_box()
        assert box and box["y"] < 844 * 1.6, box
        # Specs, inspection and terms are accordions on mobile (collapsed by default).
        for name in ("Details and documents", "Inspection report", "Auction terms"):
            toggle = B.get_by_role("button", name=name)
            expect(toggle).to_have_attribute("aria-expanded", "false")
            toggle.click()
            expect(toggle).to_have_attribute("aria-expanded", "true")
        B.mouse.wheel(0, 2500); B.wait_for_timeout(800)
        expect(B.get_by_test_id("mobile-bar")).to_be_visible(timeout=5000)
        B.screenshot(path=f"{OUT}/detail-mobile-bar.png", full_page=False)
        step("mobile: live panel right after the photos; details in accordions; sticky price bar when scrolled")
        browser.close()
    print("LIVE E2E PASSED")
finally:
    stop_server()
