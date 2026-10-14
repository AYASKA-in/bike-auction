"""
Settlement journey against the REAL local app (wrangler dev + local D1/DO), Chromium (docs/settlement.md).

A new buyer wins → the winner card links to My purchases → "Pay 25% by …" with a countdown → bidding
elsewhere is refused while the payment is owed → the buyer reports a UTR → the admin verifies it in
the Settlements queue → "Pay the balance" → the admin records the balance (cash at the yard) → the buyer
sees a gate-pass code → the admin marks the bike collected with that code. Then the deposit flow:
report a deposit → admin verifies → the buyer's buying limit is 10× and enforced.

Usage: python tests/e2e/settlement.py [port] [screenshot_dir]   (starts/stops its own wrangler dev)
"""
import json, os, re, signal, subprocess, sys, time, urllib.request
from datetime import datetime, timezone
from playwright.sync_api import expect, sync_playwright

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8797
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/e2e-settlement"
BASE = f"http://127.0.0.1:{PORT}"
WORKER = os.path.join(os.path.dirname(__file__), "..", "..", "apps", "worker")
os.makedirs(OUT, exist_ok=True)
NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))
TAG = f"S{int(time.time()) % 100000}"
PASSWORD = "Vt7#qLm2!xRw9@kZp4"
server = None
CAPTCHA_OFF = [] if os.environ.get("E2E_TURNSTILE") == "1" else ["--var", "TURNSTILE_SECRET_KEY:"]


def step(msg): print(f"✓ {msg}", flush=True)


def start_server():
    global server
    env = {**os.environ, "NO_PROXY": "*", "no_proxy": "*"}
    log = open(f"{OUT}/wrangler.log", "a")
    server = subprocess.Popen(["npx", "wrangler", "dev", "--port", str(PORT), "--ip", "127.0.0.1", *CAPTCHA_OFF,
                               "--var", "PAYMENT_UPI_ID:bikeauction.demo@upi"],
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


def login_demo(page, who):
    page.goto(f"{BASE}/login")
    page.get_by_role("button", name=who).click()
    page.get_by_role("button", name="Sign in", exact=True).last.click()
    page.wait_for_url(lambda u: "/login" not in u, timeout=15000)


def api(page, method, path, body=None):
    r = page.request.fetch(f"{BASE}/api/v1{path}", method=method,
                           headers={"origin": BASE, "content-type": "application/json"},
                           data=json.dumps(body) if body is not None else None)
    assert r.ok, (path, r.status, r.text())
    return r.json()


def iso(ms): return datetime.fromtimestamp(time.time() + ms / 1000, timezone.utc).isoformat()


def create_live_auction(admin, model, closes_in_ms, start_rupees):
    bike = api(admin, "POST", "/admin/bikes", {
        "make": "Honda", "model": model, "variant": "E2E", "manufactureYear": 2021, "registrationYear": 2021,
        "fuel": "PETROL", "engineCc": 109, "kmDriven": 12000, "ownerCount": 1, "rtoCode": "MH-12",
        "rcStatus": "ORIGINAL", "hypothecation": "NONE", "insuranceValidTill": None, "city": "Pune",
        "yard": "Hadapsar yard", "repossessed": False, "asIsWhereIs": True, "colour": None,
        "description": "E2E settlement listing. Fictional."})
    api(admin, "PUT", f"/admin/bikes/{bike['id']}/inspection", {
        "grade": "B", "sections": {k: {"condition": "GOOD", "note": ""} for k in
                                   ["engine", "transmission", "electricals", "battery", "brakes", "tyres", "suspension", "frame", "body"]},
        "visibleDamage": "", "mechanicalIssues": "", "inspectorNotes": "E2E", "inspectorName": "E2E", "inspectedAt": "2026-10-01"})
    a = api(admin, "POST", "/admin/auctions", {
        "bikeId": bike["id"], "startPriceMinor": start_rupees * 100, "reserveMinor": None,
        "startsAt": iso(-61_000), "closesAt": iso(closes_in_ms), "antiSniping": False,
        "schedule": True, "terms": "E2E settlement auction."})
    return a["view"]["auctionId"]


def bid(page, amount):
    page.locator("#bid-amount").fill(str(amount))
    page.get_by_role("button", name=re.compile("^Place bid")).click()


try:
    start_server()
    step(f"wrangler dev up on :{PORT}")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        admin = browser.new_context(viewport={"width": 1366, "height": 900}).new_page()
        N = browser.new_context(viewport={"width": 1366, "height": 900}).new_page()
        M = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
                                color_scheme="dark").new_page()
        login_demo(admin, "Admin")
        win = create_live_auction(admin, f"Activa {TAG}", 75_000, 40000)
        other = create_live_auction(admin, f"Dio {TAG}", 3_600_000, 30000)
        step("admin created a 75-second auction and a long one")

        email = f"settle.{TAG.lower()}@example.test"
        N.goto(f"{BASE}/register")
        N.get_by_label("Full name").fill("Settlement Buyer")
        N.get_by_label("Email").fill(email)
        N.get_by_label("Password", exact=True).fill(PASSWORD)
        N.get_by_test_id("consent").check()
        N.get_by_role("button", name="Create account").click()
        N.wait_for_url(lambda u: "/register" not in u, timeout=20000)
        N.goto(f"{BASE}/auctions/{win}")
        expect(N.locator('[data-conn="live"]')).to_be_visible(timeout=20000)
        bid(N, 40000)
        expect(N.get_by_test_id("leading")).to_be_visible(timeout=15000)
        step("a new buyer registered and placed the only bid")

        expect(N.get_by_test_id("result")).to_have_text("You won at ₹40,000.", timeout=120000)
        N.get_by_role("link", name="Complete your purchase").click()
        N.wait_for_url(re.compile(r"/me/purchases$"), timeout=15000)
        card = N.get_by_role("article").filter(has_text=f"Activa {TAG}")
        expect(card.get_by_text("Pay ₹10,000 by")).to_be_visible(timeout=15000)
        expect(card.get_by_text(re.compile(r"\d+h \d+m left|\d+ h left|left"))).to_be_visible()
        expect(N.get_by_text("bikeauction.demo@upi")).to_be_visible()
        expect(N.get_by_role("link", name=re.compile("^Purchases")).locator("visible=true").first).to_contain_text("1")
        N.screenshot(path=f"{OUT}/purchases-pay-25.png", full_page=True)
        step("won → 'Complete your purchase' → My purchases: Pay ₹10,000 (25%) with countdown, UPI ID, nav badge")

        N.goto(f"{BASE}/auctions/{other}")
        expect(N.locator('[data-conn="live"]')).to_be_visible(timeout=20000)
        bid(N, 30000)
        expect(N.get_by_text(re.compile("Complete the payment for"))).to_be_visible(timeout=10000)
        step("bidding elsewhere is refused while the 25% is owed, with a clear reason")

        N.goto(f"{BASE}/me/purchases")
        card = N.get_by_role("article").filter(has_text=f"Activa {TAG}")
        card.get_by_label("Transaction reference (UTR)").fill(f"UTR{TAG}0001")
        card.get_by_role("button", name="Report payment").click()
        expect(card.get_by_text("₹10,000 reported, being verified")).to_be_visible(timeout=15000)
        step("buyer reported the UPI payment by its UTR")

        admin.goto(f"{BASE}/admin/settlements?status=awaiting_verification")
        expect(admin.get_by_role("heading", name="Settlements")).to_be_visible(timeout=15000)
        admin.get_by_role("link", name=f"2021 Honda Activa {TAG} E2E").click()
        expect(admin.get_by_text(f"UTR{TAG}0001")).to_be_visible(timeout=15000)
        admin.screenshot(path=f"{OUT}/admin-settlement-verify.png", full_page=True)
        admin.get_by_role("button", name="Verify").click()
        expect(admin.get_by_text("Awaiting balance").first).to_be_visible(timeout=15000)
        step("admin verified the payment from the Settlements queue → Awaiting balance")

        N.reload()
        card = N.get_by_role("article").filter(has_text=f"Activa {TAG}")
        expect(card.get_by_text("Pay the balance").first).to_be_visible(timeout=15000)
        due = api(N, "GET", "/me/purchases")
        s = next(x for x in due["items"] if x["auctionId"] == win)
        assert s["dueNowMinor"] == 4_000_000 + 80_000 + 14_400 - 1_000_000, s  # price + 2% + GST − 25%
        step(f"buyer now sees 'Pay the balance' (₹{s['dueNowMinor'] // 100:,}: price + 2% fee + 18% GST − 25%)")

        admin.get_by_text("Record a payment").click()
        admin.get_by_label("Amount (₹)").fill(str(s["dueNowMinor"] // 100))
        admin.get_by_label("Receipt or reference").fill(f"YARD-{TAG}")
        admin.get_by_role("button", name="Record").click()
        expect(admin.get_by_text("Paid, to collect").first).to_be_visible(timeout=15000)
        step("admin recorded the balance (cash at the yard) → Paid, to collect")

        N.reload()
        card = N.get_by_role("article").filter(has_text=f"Activa {TAG}")
        expect(card.get_by_text("Paid in full. Collect within 7 days.")).to_be_visible(timeout=15000)
        gate = api(N, "GET", "/me/purchases")
        code = next(x for x in gate["items"] if x["auctionId"] == win)["gatePass"]
        assert re.fullmatch(r"[A-HJ-NP-Z2-9]{8}", code), code
        expect(card.get_by_text(code)).to_be_visible()
        N.screenshot(path=f"{OUT}/purchases-gate-pass.png", full_page=True)
        admin.get_by_label("Gate-pass code from the buyer").fill(code)
        admin.get_by_role("button", name="Mark collected").click()
        expect(admin.get_by_text("Collected").first).to_be_visible(timeout=15000)
        step("buyer got a gate-pass code; admin marked the bike collected with it")

        # Deposit and buying limit (mobile, dark).
        M.goto(f"{BASE}/login")
        M.get_by_label("Email").fill(email)
        M.get_by_label("Password", exact=True).fill(PASSWORD)
        M.get_by_role("button", name="Sign in", exact=True).last.click()
        M.wait_for_url(lambda u: "/login" not in u, timeout=15000)
        M.goto(f"{BASE}/me/deposit")
        expect(M.get_by_role("heading", name="Deposit and buying limit")).to_be_visible(timeout=15000)
        M.get_by_label("Transaction reference (UTR)").fill(f"DEP{TAG}0001")
        M.get_by_role("button", name="Report deposit").click()
        expect(M.get_by_text("Being verified")).to_be_visible(timeout=15000)
        admin.goto(f"{BASE}/admin/deposits")
        row = admin.get_by_role("row").filter(has_text=f"DEP{TAG}0001")
        row.get_by_role("button", name="Verify").click()
        expect(row).to_have_count(0, timeout=15000)
        M.reload()
        expect(M.locator("dd").filter(has_text="₹1,00,000")).to_be_visible(timeout=15000)  # 10× ₹10,000
        M.screenshot(path=f"{OUT}/deposit-mobile-dark.png", full_page=True)
        M.goto(f"{BASE}/auctions/{other}")
        expect(M.locator('[data-conn="live"]')).to_be_visible(timeout=20000)
        r = M.request.post(f"{BASE}/api/v1/auctions/{other}/bids",
                           headers={"origin": BASE, "content-type": "application/json", "idempotency-key": f"k-{TAG}-limit-1"},
                           data=json.dumps({"amountMinor": 10_100_000}))
        assert r.status == 403 and "buying limit" in r.text(), (r.status, r.text())
        step("deposit reported → admin verified → buying limit ₹1,00,000 (10×) shown and enforced")
        browser.close()
    print("SETTLEMENT JOURNEY PASSED")
finally:
    stop_server()
