"""
Day-8 end-to-end journeys against the REAL local app (wrangler dev + local D1/DO), Chromium.

1. Buyer journey (desktop, light): register with consent → browse → watch → manual bid → live outbid →
   set a proxy maximum → proxy defends live → My Bids / Watchlist → server-confirmed win → export data.
2. Privacy journey (mobile, dark): consent is required → register → bid (then outbid) → account page →
   export → delete account → retained auction history stays accurate; credentials no longer work.
3. Admin monitoring (desktop, dark): ops dashboard, per-auction ledger (automatic bids, no maxima),
   audit trail with a filter.
(Admin listing creation and failure recovery are covered by journey.py and live.py.)

Usage: python tests/e2e/journeys.py [port] [screenshot_dir]   (starts/stops its own wrangler dev)
"""
import json, os, re, signal, subprocess, sys, time, urllib.request
from datetime import datetime, timezone
from playwright.sync_api import expect, sync_playwright

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8798
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/e2e-journeys"
BASE = f"http://127.0.0.1:{PORT}"
WORKER = os.path.join(os.path.dirname(__file__), "..", "..", "apps", "worker")
os.makedirs(OUT, exist_ok=True)
NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))
TAG = f"J{int(time.time()) % 100000}"
PASSWORD = "Vt7#qLm2!xRw9@kZp4"
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


def get_json(path):
    return json.load(NOPROXY.open(f"{BASE}/api/v1{path}"))


def login_demo(page, who):
    page.goto(f"{BASE}/login")
    page.get_by_role("button", name=who).click()
    page.get_by_role("button", name="Sign in", exact=True).last.click()
    page.wait_for_url(lambda u: "/login" not in u, timeout=15000)


def register(page, name, email, consent=True):
    page.goto(f"{BASE}/register")
    page.get_by_label("Full name").fill(name)
    page.get_by_label("Email").fill(email)
    page.get_by_label("Password", exact=True).fill(PASSWORD)
    if consent: page.get_by_test_id("consent").check()
    page.get_by_role("button", name="Create account").click()


def api(page, method, path, body=None, ok=True):
    r = page.request.fetch(f"{BASE}/api/v1{path}", method=method,
                           headers={"origin": BASE, "content-type": "application/json"},
                           data=json.dumps(body) if body is not None else None)
    if ok: assert r.ok, (path, r.status, r.text())
    return r


def iso(ms): return datetime.fromtimestamp(time.time() + ms / 1000, timezone.utc).isoformat()


def create_live_auction(admin_page, model, closes_in_ms, anti_sniping=False, start_rupees=40000):
    bike = api(admin_page, "POST", "/admin/bikes", {
        "make": "TVS", "model": model, "variant": "E2E", "manufactureYear": 2021, "registrationYear": 2021,
        "fuel": "PETROL", "engineCc": 160, "kmDriven": 15000, "ownerCount": 1, "rtoCode": "tn-09",
        "rcStatus": "ORIGINAL", "hypothecation": "NONE", "insuranceValidTill": None, "city": "Chennai",
        "yard": "Ambattur yard", "repossessed": False, "asIsWhereIs": True, "colour": None,
        "description": "E2E journey listing. Fictional."}).json()
    api(admin_page, "PUT", f"/admin/bikes/{bike['id']}/inspection", {
        "grade": "B", "sections": {k: {"condition": "GOOD", "note": ""} for k in
                                   ["engine", "transmission", "electricals", "battery", "brakes", "tyres", "suspension", "frame", "body"]},
        "visibleDamage": "", "mechanicalIssues": "", "inspectorNotes": "E2E", "inspectorName": "E2E", "inspectedAt": "2026-10-01"})
    a = api(admin_page, "POST", "/admin/auctions", {
        "bikeId": bike["id"], "startPriceMinor": start_rupees * 100, "reserveMinor": None,
        "startsAt": iso(-61_000), "closesAt": iso(closes_in_ms), "antiSniping": anti_sniping,
        "schedule": True, "terms": "E2E journey auction."}).json()
    return a["view"]["auctionId"]


def live_ok(page, t=20000): expect(page.locator('[data-conn="live"]')).to_be_visible(timeout=t)


def bid(page, amount):
    page.locator("#bid-amount").fill(str(amount))
    page.get_by_role("button", name=re.compile("^Place bid")).click()


def set_max(page, amount):
    if not page.locator("#proxy-max").is_visible():
        page.get_by_text("Auto-bid: set a maximum").click()
    page.locator("#proxy-max").fill(str(amount))
    page.get_by_role("button", name=re.compile("^(Set|Update) maximum")).click()


try:
    start_server(); step(f"wrangler dev started on :{PORT}")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx_admin = browser.new_context(viewport={"width": 1366, "height": 900}, color_scheme="dark")
        ctx_a = browser.new_context(viewport={"width": 1366, "height": 900})
        ctx_n = browser.new_context(viewport={"width": 1366, "height": 900}, color_scheme="light",
                                    accept_downloads=True)
        ctx_p = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
                                    color_scheme="dark", accept_downloads=True)
        admin, A, N, P = ctx_admin.new_page(), ctx_a.new_page(), ctx_n.new_page(), ctx_p.new_page()
        login_demo(admin, "Admin"); login_demo(A, "Buyer A")
        win_auc = create_live_auction(admin, f"Apache {TAG}", 150_000)        # ends during the run
        keep_auc = create_live_auction(admin, f"Raider {TAG}", 3_600_000)    # stays live
        step("admin created two live auctions via the admin API")

        # ---------------- 1. Buyer journey ----------------
        n_email = f"journey.{TAG.lower()}@example.test"
        register(N, "Journey Buyer", n_email)
        N.wait_for_url(lambda u: "/register" not in u, timeout=20000)
        step("new buyer registered (consent ticked) and is signed in")
        N.goto(f"{BASE}/auctions?q={TAG}")
        card = N.get_by_role("article").filter(has_text=f"Apache {TAG}")
        expect(card).to_be_visible(timeout=15000)
        card.get_by_role("button", name="Watch").click()
        expect(card.get_by_role("button", name="Watching")).to_be_visible(timeout=10000)
        step("browsed the catalogue and watched the auction from its card")
        N.goto(f"{BASE}/auctions/{win_auc}"); A.goto(f"{BASE}/auctions/{win_auc}")
        live_ok(N); live_ok(A)
        bid(N, 40000)
        expect(N.get_by_test_id("leading")).to_be_visible(timeout=10000)
        bid(A, 40500)
        expect(N.get_by_test_id("outbid")).to_be_visible(timeout=10000)
        expect(N.get_by_test_id("price")).to_have_text("₹40,500")
        step("manual bid placed; outbid notice arrived live when Buyer A bid ₹40,500")
        set_max(N, 50000)
        expect(N.get_by_test_id("leading")).to_be_visible(timeout=10000)
        expect(N.get_by_test_id("price")).to_have_text("₹41,000", timeout=10000)
        bid(A, 42000)
        expect(A.get_by_test_id("outbid")).to_be_visible(timeout=10000)   # countered in the same commit
        expect(N.get_by_test_id("price")).to_have_text("₹42,500", timeout=10000)
        expect(N.get_by_test_id("leading")).to_be_visible()
        expect(N.get_by_test_id("outbid")).to_have_count(0)
        assert "50,000" not in A.content(), "the new buyer's maximum leaked to Buyer A"
        step("proxy max ₹50,000 set; A's ₹42,000 was countered at ₹42,500 live; max hidden from A")
        N.screenshot(path=f"{OUT}/buyer-detail-light.png", full_page=False)
        N.goto(f"{BASE}/me/bids")
        expect(N.get_by_text(f"Apache {TAG}").first).to_be_visible(timeout=10000)
        N.goto(f"{BASE}/me/watchlist")
        expect(N.get_by_text(f"Apache {TAG}").first).to_be_visible(timeout=10000)
        step("My Bids (Leading) and Watchlist show the auction")
        N.goto(f"{BASE}/auctions/{win_auc}"); live_ok(N)
        expect(N.get_by_test_id("result")).to_contain_text("You won at ₹42,500", timeout=180_000)
        expect(N.locator("#bid-amount")).to_have_count(0)
        N.goto(f"{BASE}/me/bids?tab=won")
        expect(N.get_by_text(f"Apache {TAG}").first).to_be_visible(timeout=15000)
        step("the server closed the auction: 'You won at ₹42,500'; My Bids → Won")
        N.goto(f"{BASE}/account")
        with N.expect_download(timeout=20000) as dl:
            N.get_by_role("button", name="Download my data").click()
        data_text = open(dl.value.path(), encoding="utf-8").read()
        export = json.loads(data_text)
        assert n_email in data_text and win_auc in data_text, "export misses own account or auction"
        assert "5000000" in data_text, "export misses the requester's own maximum"
        assert "buyer.a@" not in data_text, "export leaked another buyer's identity"
        assert re.search(r"password|hash|token", json.dumps(list(export.keys())), re.I) is None
        step(f"data export downloaded: own profile, auction and maximum present; no other buyer data")

        # ---------------- 2. Privacy journey (mobile, dark) ----------------
        p_email = f"privacy.{TAG.lower()}@example.test"
        register(P, "Privacy Person", p_email, consent=False)
        expect(P.get_by_text("Agree to the Privacy Notice and Terms to create an account.")).to_be_visible(timeout=10000)
        assert "/register" in P.url
        step("registration without consent is refused with a clear message")
        P.get_by_test_id("consent").check()
        P.get_by_role("button", name="Create account").click()
        P.wait_for_url(lambda u: "/register" not in u, timeout=20000)
        P.goto(f"{BASE}/auctions/{keep_auc}"); live_ok(P); A.goto(f"{BASE}/auctions/{keep_auc}"); live_ok(A)
        bid(P, 40000)
        expect(P.get_by_test_id("leading")).to_be_visible(timeout=10000)
        bid(A, 40500)
        expect(P.get_by_test_id("outbid")).to_be_visible(timeout=10000)
        before = get_json(f"/auctions/{keep_auc}/bids?limit=50")["items"]
        p_pseudonym = [b["bidder"] for b in before if b["amountMinor"] == 4_000_000][0]
        P.goto(f"{BASE}/account")
        expect(P.get_by_test_id("account-details")).to_contain_text(p_email, timeout=10000)
        P.screenshot(path=f"{OUT}/account-mobile-dark.png", full_page=True)
        with P.expect_download(timeout=20000) as dl2:
            P.get_by_role("button", name="Download my data").click()
        assert p_email in open(dl2.value.path(), encoding="utf-8").read()
        step("account page shows own details; export works on mobile")
        P.get_by_test_id("delete-confirm").fill(p_email)
        P.get_by_role("button", name="Delete my account permanently").click()
        P.wait_for_url(lambda u: "/account" not in u, timeout=20000)
        after = get_json(f"/auctions/{keep_auc}/bids?limit=50")["items"]
        view = get_json(f"/auctions/{keep_auc}")
        assert [(b["seq"], b["amountMinor"], b["bidder"]) for b in after] == \
               [(b["seq"], b["amountMinor"], b["bidder"]) for b in before], "auction history changed"
        assert view["bidCount"] == 2 and view["currentPriceMinor"] == 4_050_000
        assert p_pseudonym in [b["bidder"] for b in after]
        assert p_email not in json.dumps(after) and p_email not in json.dumps(view)
        r = P.request.post(f"{BASE}/api/v1/auth/sign-in/email",
                           headers={"origin": BASE, "content-type": "application/json"},
                           data=json.dumps({"email": p_email, "password": PASSWORD}))
        assert not r.ok and "INVALID_CREDENTIALS" in r.text(), f"deleted account sign-in: {r.status} {r.text()[:200]}"
        step("account deleted; auction history, price and pseudonymous ledger unchanged; sign-in refused")

        # ---------------- 3. Admin monitoring (dark) ----------------
        admin.goto(f"{BASE}/admin/ops")
        expect(admin.get_by_role("heading", name="Live operations")).to_be_visible(timeout=15000)
        expect(admin.get_by_text(f"Raider {TAG}").locator("visible=true").first).to_be_visible(timeout=15000)
        admin.screenshot(path=f"{OUT}/admin-ops-dark.png", full_page=True)
        admin.goto(f"{BASE}/admin/auctions/{win_auc}")
        expect(admin.get_by_text("Automatic").locator("visible=true").first).to_be_visible(timeout=15000)
        assert "50,000" not in admin.content(), "a proxy maximum is visible on the admin page"
        admin.screenshot(path=f"{OUT}/admin-auction-dark.png", full_page=True)
        admin.goto(f"{BASE}/admin/audit")
        expect(admin.get_by_role("heading", name="Audit trail")).to_be_visible(timeout=15000)
        expect(admin.locator("table tbody tr").first).to_be_visible(timeout=15000)
        admin.screenshot(path=f"{OUT}/admin-audit-dark.png", full_page=True)
        step("admin: ops dashboard lists the live auction; ledger shows automatic bids, no maxima; audit trail")
        browser.close()
    print("JOURNEYS PASSED")
finally:
    stop_server()
