"""
Automated accessibility check (axe-core, WCAG 2.x A/AA rules) on every main page of the REAL local app,
desktop and mobile. Fails on any "serious" or "critical" violation; lists moderate/minor ones.

Usage: python tests/e2e/a11y.py http://127.0.0.1:8787
Needs: Playwright for Python + axe-playwright-python (pip install axe-playwright-python); a seeded local app.
"""
import json, sys, urllib.request
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))
axe = Axe()
OPTIONS = {"runOnly": {"type": "tag", "values": ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]}}


def first_live_auction():
    data = json.load(NOPROXY.open(f"{BASE}/api/v1/auctions?status=LIVE&limit=1"))
    return data["items"][0]["auctionId"]


def first_ended_auction():
    data = json.load(NOPROXY.open(f"{BASE}/api/v1/auctions?status=ENDED&limit=1"))
    return data["items"][0]["auctionId"] if data["items"] else None


def login(page, who):
    page.goto(f"{BASE}/login")
    page.get_by_role("button", name=who).click()
    page.get_by_role("button", name="Sign in", exact=True).last.click()
    page.wait_for_url(lambda u: "/login" not in u, timeout=15000)


failures, notes = [], []


def check(page, label, path):
    page.goto(f"{BASE}{path}")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1200)  # live panel / lazy chunks settle
    res = axe.run(page, options=OPTIONS)
    for v in res.response["violations"]:
        line = f"[{label}] {path}: {v['impact']} {v['id']}: {v['help']} ({len(v['nodes'])} node(s)) e.g. {v['nodes'][0]['target']}"
        (failures if v["impact"] in ("serious", "critical") else notes).append(line)
    print(f"{'✓' if not any(path in f and label in f for f in failures) else '✗'} {label} {path}", flush=True)


live = first_live_auction()
ended = first_ended_auction()
with sync_playwright() as p:
    browser = p.chromium.launch()
    for label, ctx_args in [
        ("desktop", {"viewport": {"width": 1366, "height": 900}}),
        ("mobile", {"viewport": {"width": 390, "height": 844}, "is_mobile": True, "has_touch": True}),
    ]:
        anon = browser.new_context(**ctx_args).new_page()
        for path in ["/", "/auctions", f"/auctions/{live}", "/login", "/register"]:
            check(anon, f"{label}/anon", path)
        if ended:
            check(anon, f"{label}/anon", f"/auctions/{ended}")
        buyer = browser.new_context(**ctx_args).new_page()
        login(buyer, "Buyer A")
        for path in [f"/auctions/{live}", "/me/bids", "/me/watchlist", "/me/purchases", "/me/deposit"]:
            check(buyer, f"{label}/buyer", path)
        admin = browser.new_context(**ctx_args).new_page()
        login(admin, "Admin")
        for path in ["/admin", "/admin/bikes", "/admin/bikes/new", "/admin/settlements", "/admin/deposits"]:
            check(admin, f"{label}/admin", path)
    browser.close()

for n in notes:
    print("  note:", n)
if failures:
    print("\nSERIOUS/CRITICAL VIOLATIONS:")
    for f in failures:
        print("  ", f)
    sys.exit(1)
print("A11Y PASSED (no serious or critical violations)")
