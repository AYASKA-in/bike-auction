"""
Day-5 end-to-end journey against a REAL local app (wrangler dev + local D1/R2/DO), in Chromium.
Admin: sign in → add motorcycle → inspection → upload photo → draft auction → schedule.
Buyer: sign in → catalogue search → open auction → see photo/inspection → place a bid.
Also checks that the stored photo has no EXIF (GPS) data.

Usage: python tests/e2e/journey.py http://127.0.0.1:8787 [screenshot_dir]
(Playwright for Python + Pillow; the app must be seeded: pnpm --filter @bike/worker seed:local)
"""
import io, os, sys, time, urllib.request
from datetime import datetime, timedelta, timezone
from PIL import Image, ImageDraw
from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/e2e"
os.makedirs(OUT, exist_ok=True)
IST = timezone(timedelta(hours=5, minutes=30))
MODEL = f"Hunter 350 E2E{int(time.time()) % 100000}"

def photo_with_gps(path):
    img = Image.new("RGB", (1600, 1200), (236, 238, 235))
    d = ImageDraw.Draw(img)
    d.ellipse((250, 650, 650, 1050), outline=(29, 33, 37), width=28)
    d.ellipse((1000, 650, 1400, 1050), outline=(29, 33, 37), width=28)
    d.line((450, 850, 800, 500, 1150, 500, 1200, 850), fill=(242, 92, 5), width=36)
    exif = Image.Exif()
    exif[0x8825] = {1: "N", 2: (28.0, 33.0, 0.0), 3: "E", 4: (77.0, 16.0, 0.0)}  # GPS IFD
    exif[0x0110] = "Test Phone Model"
    img.save(path, "JPEG", quality=90, exif=exif.tobytes())
    assert b"Exif" in open(path, "rb").read()[:200]

def login(page, who):
    page.goto(f"{BASE}/login")
    page.get_by_role("button", name=who).click()
    page.get_by_role("button", name="Sign in", exact=True).last.click()
    page.wait_for_url(lambda u: "/login" not in u, timeout=15000)

def step(msg): print(f"✓ {msg}", flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch()
    admin = browser.new_context(viewport={"width": 1366, "height": 900})
    a = admin.new_page()
    login(a, "Admin"); step("admin signed in")

    a.goto(f"{BASE}/admin"); expect(a.get_by_role("heading", name="Auction desk")).to_be_visible()
    a.screenshot(path=f"{OUT}/admin-desk.png", full_page=True)

    a.goto(f"{BASE}/admin/bikes/new")
    f = {"Make": "Royal Enfield", "Model": MODEL, "Manufacturing year": "2023", "Registration year": "2023",
         "Engine (cc)": "349", "Kilometres driven": "7200", "Previous owners": "1", "RTO code": "dl-8s",
         "City": "New Delhi", "Storage yard": "Okhla Phase II yard"}
    for k, v in f.items(): a.get_by_label(k, exact=True).fill(v)
    a.get_by_label("Repossessed vehicle").check()
    a.get_by_label("Description and condition notes").fill("E2E test listing. Fictional.")
    a.get_by_role("button", name="Save and continue").click()
    a.wait_for_url("**/admin/bikes/bike_*", timeout=15000); step("motorcycle created")
    bike_url = a.url.split("#")[0]

    a.get_by_label("Inspector", exact=True).fill("E2E Inspector")
    a.get_by_label("Overall grade", exact=True).select_option("A")
    a.get_by_role("button", name="Save inspection").click()
    expect(a.get_by_text("Inspection saved.")).to_be_visible(timeout=15000); step("inspection recorded")

    path = f"{OUT}/gps.jpg"; photo_with_gps(path)
    a.locator('input[type="file"]').set_input_files(path)
    expect(a.locator("#photos img").first).to_be_visible(timeout=20000); step("photo uploaded (resized in browser)")
    stored = a.locator("#photos img").first.get_attribute("src")
    blob = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(f"{BASE}{stored}").read()
    assert b"Exif" not in blob and b"GPS" not in blob, "EXIF survived upload"
    w, h = Image.open(io.BytesIO(blob)).size
    assert max(w, h) <= 2000, (w, h)
    step(f"stored photo has no EXIF/GPS; {w}x{h}")

    now = datetime.now(IST)
    a.get_by_label("Starting bid (₹)").fill("150000")
    a.get_by_label("Hidden reserve (₹, optional)").fill("165000")
    a.get_by_label("Starts (IST)").fill((now - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M"))
    a.get_by_label("Closes (IST)").fill((now + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M"))
    a.get_by_role("button", name="Create draft auction").click()
    expect(a.get_by_role("button", name="Schedule auction")).to_be_visible(timeout=15000); step("draft auction created")
    a.screenshot(path=f"{OUT}/admin-bike-editor.png", full_page=True)
    a.get_by_role("button", name="Schedule auction").click()
    expect(a.get_by_role("link", name="View public page")).to_be_visible(timeout=15000); step("auction scheduled (live)")

    buyer = browser.new_context(viewport={"width": 1366, "height": 900})
    b = buyer.new_page()
    login(b, "Buyer A"); step("buyer signed in")
    b.goto(f"{BASE}/auctions?q={MODEL.split()[-1]}")
    card = b.get_by_role("link", name=f"Royal Enfield {MODEL}")
    expect(card).to_be_visible(timeout=15000); step("buyer found it via catalogue search")
    b.goto(f"{BASE}/auctions"); b.wait_for_timeout(1500)
    b.screenshot(path=f"{OUT}/catalogue-desktop.png", full_page=True)
    b.goto(f"{BASE}/auctions?q={MODEL.split()[-1]}")
    b.get_by_role("link", name=f"Royal Enfield {MODEL}").click()
    expect(b.get_by_role("heading", name="Inspection report")).to_be_visible(timeout=15000)
    expect(b.locator("[data-conn=\"live\"]")).to_be_visible(timeout=15000)
    expect(b.get_by_text("Reserve not met")).to_be_visible()
    assert "165000" not in b.content() and "1,65,000" not in b.content(), "reserve leaked to buyer page"
    step("detail page: photo, inspection, live feed, reserve hidden")
    b.get_by_role("button", name="Place bid").click()
    expect(b.get_by_test_id("leading")).to_be_visible(timeout=15000)
    expect(b.get_by_text("₹1,50,000").first).to_be_visible(); step("buyer bid accepted; live panel updated")
    b.screenshot(path=f"{OUT}/detail-desktop.png", full_page=True)

    m = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = m.new_page()
    mp.goto(f"{BASE}/auctions"); mp.wait_for_timeout(1500)
    expect(mp.get_by_role("button", name="Filters")).to_be_visible()
    mp.screenshot(path=f"{OUT}/catalogue-mobile.png", full_page=True)
    mp.get_by_role("button", name="Filters").click()
    expect(mp.get_by_label("Search")).to_be_visible(); step("mobile filters open")
    mp.goto(b.url); mp.wait_for_timeout(2000)
    mp.screenshot(path=f"{OUT}/detail-mobile.png", full_page=True)
    mp.goto(BASE); mp.wait_for_timeout(1500)
    mp.screenshot(path=f"{OUT}/home-mobile.png", full_page=True)
    a.goto(BASE); a.wait_for_timeout(1500); a.screenshot(path=f"{OUT}/home-desktop.png", full_page=True)
    browser.close()
print("JOURNEY PASSED")
