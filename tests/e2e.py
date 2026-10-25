# /// script
# requires-python = ">=3.12"
# dependencies = ["playwright==1.64.1"]
# ///
"""End-to-End-Tests für den Refill-Finder.

Startet einen lokalen Webserver, öffnet die App in Headless-Chromium und prüft die wichtigsten
Abläufe gegen die Live-API von Karte von Morgen. Die Ergebnisse hängen daher von den aktuellen
Daten ab; geprüft wird Verhalten, keine konkreten Stationsnamen.

Einmalig:  uv run tests/e2e.py --install     # Chromium für diese Playwright-Version laden
           sudo apt install libnss3          # falls Chromium wegen fehlender Bibliotheken nicht startet
Aufruf:    uv run tests/e2e.py               # alle Tests
           uv run tests/e2e.py --headed      # mit sichtbarem Browser
           uv run tests/e2e.py --screenshots shots/
           uv run tests/e2e.py --full        # zusätzlich "Alle Stationen speichern" (~60 API-Anfragen)
"""
import argparse
import functools
import http.server
import re
import subprocess
import sys
import threading
from contextlib import contextmanager
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OLDENBURG = {"latitude": 53.1405, "longitude": 8.2135, "accuracy": 30}
BERLIN = {"latitude": 52.5208, "longitude": 13.4094, "accuracy": 30}
PHONE = {
    "viewport": {"width": 390, "height": 844},
    "device_scale_factor": 2,
    "is_mobile": True,
    "has_touch": True,
    "locale": "de-DE",
    "timezone_id": "Europe/Berlin",
}
NETWORK_ERROR = re.compile(r"ERR_INTERNET_DISCONNECTED|ERR_FAILED|Failed to fetch")

failures: list[str] = []


def check(condition, message, detail=""):
    print(f"  {'✓' if condition else '✗'} {message}{f'  ({detail})' if detail and not condition else ''}")
    if not condition:
        failures.append(message)
    return condition


def section(title):
    print(f"\n{title}")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@contextmanager
def serve():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://localhost:{server.server_port}/"
    finally:
        server.shutdown()


class ConsoleWatcher:
    """Sammelt JS-Fehler; Netzwerkfehler sind nur in Offline-Phasen erlaubt."""

    def __init__(self, page):
        self.errors: list[str] = []
        self.offline = False
        page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        page.on("console", self._console)

    def _console(self, msg):
        if msg.type != "error":
            return
        if self.offline and NETWORK_ERROR.search(msg.text):
            return
        self.errors.append(f"console.error: {msg.text}")


def distances_in_meters(page):
    out = []
    for text in page.locator(".list .item .item-dist b").all_inner_texts():
        value, unit = text.replace(" ", " ").split(" ")
        meters = float(value.replace(".", "").replace(",", "."))
        out.append(meters * 1000 if unit == "km" else meters)
    return out


def user_offset(page):
    """Abstand des Standortpunkts zur Mitte des sichtbaren Kartenbereichs in Pixeln."""
    return page.evaluate("""() => {
        const r = document.querySelector('.user-loc').getBoundingClientRect();
        const top = document.querySelector('.topbar').getBoundingClientRect().bottom + 8;
        const bottom = document.getElementById('sheet').getBoundingClientRect().top;
        return Math.round(Math.hypot(r.x + r.width / 2 - innerWidth / 2, r.y + r.height / 2 - (top + bottom) / 2));
    }""")


def drag_sheet_up(context, page):
    head = page.locator("#sheet-head").bounding_box()
    x, y = head["x"] + head["width"] / 2, head["y"] + 10
    cdp = context.new_cdp_session(page)

    def touch(kind, yy):
        points = [] if kind == "touchEnd" else [{"x": x, "y": yy}]
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": points})

    touch("touchStart", y)
    for i in range(1, 16):
        touch("touchMove", y - i * 20)
        page.wait_for_timeout(16)
    touch("touchEnd", 0)
    page.wait_for_timeout(500)


def shot(page, args, name):
    if args.screenshots:
        page.screenshot(path=str(Path(args.screenshots) / f"{name}.png"))


def test_unit(browser, base):
    section("Unit-Tests (tests/index.html)")
    page = browser.new_page()
    page.goto(f"{base}tests/")
    page.wait_for_selector("#summary[data-done]", timeout=10000)
    failed = int(page.get_attribute("#summary", "data-failed"))
    check(failed == 0, page.inner_text("#summary"), "\n".join(page.locator(".fail").all_inner_texts()))
    page.close()


def test_mobile(browser, base, args):
    """Hauptablauf am Handy. Gibt die ID einer Station für den Deep-Link-Test zurück."""
    context = browser.new_context(**PHONE, geolocation=OLDENBURG, permissions=["geolocation"])
    page = context.new_page()
    console = ConsoleWatcher(page)

    section("Handy: Start mit erteilter Standortfreigabe")
    page.goto(base)
    page.wait_for_selector(".list .item .item-meta", timeout=30000)
    page.wait_for_timeout(1000)
    check(page.inner_text("#sheet-title") == "In deiner Nähe", "Titel bezieht sich auf den Standort")
    count = page.locator(".list .item").count()
    check(count >= 10, "Liste enthält mindestens 10 Stationen", f"{count}")
    dists = distances_in_meters(page)
    check(dists == sorted(dists), "Liste ist nach Entfernung sortiert", f"{dists[:8]}")
    page.wait_for_timeout(800)
    check(abs(user_offset(page)) < 3, "Karte ist auf den Standort zentriert", f"Abstand zur Mitte: {user_offset(page)} px")
    shot(page, args, "1-liste")

    section("Handy: Detailansicht")
    page.locator(".list .item button").first.click()
    page.wait_for_selector("#view-detail .facts", timeout=15000)
    station_hash = page.evaluate("location.hash")
    check(station_hash.startswith("#/s/"), "Deep-Link im URL-Fragment", station_hash)
    text = page.inner_text("#view-detail")
    check("null" not in text and "[object" not in text and "false" not in text, "Keine Platzhalter-Artefakte im Text")
    check(page.locator("#view-detail a.btn-primary", has_text="Route").count() == 1, "Route-Button vorhanden")
    page.wait_for_timeout(1200)
    shot(page, args, "2-detail")

    page.click("#back-btn")
    page.wait_for_timeout(500)
    check(page.evaluate("location.hash") == "", "Zurück entfernt das URL-Fragment")
    check(page.is_visible("#view-list"), "Zurück zeigt wieder die Liste")

    section("Handy: Marker antippen")
    # openDetail hat die Station in die Mitte des sichtbaren Kartenbereichs geschoben.
    x, y = page.evaluate("""() => {
        const top = document.querySelector('.topbar').getBoundingClientRect().bottom + 8;
        const bottom = document.getElementById('sheet').getBoundingClientRect().top;
        return [innerWidth / 2, (top + bottom) / 2];
    }""")
    page.touchscreen.tap(x, y)
    page.wait_for_timeout(800)
    check(page.is_visible("#view-detail") and page.evaluate("location.hash").startswith("#/s/"), "Tipp auf Marker öffnet Station")
    page.click("#back-btn")
    page.wait_for_timeout(500)

    section("Handy: Bottom-Sheet wischen")
    drag_sheet_up(context, page)
    check(page.evaluate("document.body.dataset.snap") == "full", "Wischen nach oben öffnet das Sheet ganz")
    shot(page, args, "3-sheet-voll")

    # Aus dem vollen Sheet heraus geöffnet: Sheet auf halbe Höhe, Station mittig im sichtbaren Kartenbereich
    page.locator(".list .item button").nth(1).click()
    page.wait_for_selector("#view-detail .facts", timeout=15000)
    page.wait_for_timeout(1200)
    sel = page.evaluate("location.hash").removeprefix("#/s/")
    offset = page.evaluate("""id => {
        const li = document.querySelector(`.list .item[data-id="${id}"]`);
        const view = JSON.parse(localStorage.getItem('refill:view'));
        const scale = 256 * 2 ** view.zoom;
        const merc = (lat, lng) => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * scale;
        const m = document.getElementById('map').getBoundingClientRect();
        const top = document.querySelector('.topbar').getBoundingClientRect().bottom + 8;
        const bottom = document.getElementById('sheet').getBoundingClientRect().top;
        const y = merc(+li.dataset.lat) - merc(view.lat) + m.height / 2;
        return Math.round(y - (top + bottom) / 2);
    }""", sel)
    check(page.evaluate("document.body.dataset.snap") == "half", "Station aus vollem Sheet öffnet auf halber Höhe")
    check(abs(offset) < 30, "Station liegt mittig im sichtbaren Kartenbereich", f"Abstand zur Mitte: {offset}px")
    page.click("#back-btn")
    page.wait_for_timeout(500)

    section("Handy: Filter")
    page.click('.chip[data-filter="open"]')
    page.wait_for_timeout(400)
    statuses = page.locator(".list .item").evaluate_all(
        "items => items.map(i => i.querySelector('.status')?.className || '')")
    check(all(re.search(r"\b(open|soon|public)\b", s) for s in statuses),
          "'Jetzt geöffnet' zeigt nur geöffnete Stationen", f"{statuses}")
    page.click('.chip[data-filter="open"]')

    page.click('.chip[data-filter="fountain"]')
    page.wait_for_function("!document.querySelector('#sheet-sub').textContent.startsWith('Suche')", timeout=30000)
    page.wait_for_timeout(1500)
    icons = page.locator(".list .item .type-icon").evaluate_all("els => els.map(e => e.classList.contains('fountain'))")
    check(len(icons) > 0 and all(icons), "'Trinkbrunnen' zeigt nur Trinkbrunnen", f"{len(icons)} Einträge")
    page.click('.chip[data-filter="fountain"]')

    section("Handy: Ortssuche")
    page.fill("#q", "Bremen Marktplatz")
    result = page.locator('#search-results li:has-text("Bremen") button').first
    result.wait_for(timeout=15000)
    shot(page, args, "4-suche")
    result.click()
    page.wait_for_function("document.querySelector('#sheet-title').textContent.startsWith('Nahe')", timeout=15000)
    page.wait_for_selector(".list .item", timeout=30000)
    check(True, f"Suchergebnis gewählt: {page.inner_text('#sheet-title')}")
    page.wait_for_timeout(1500)
    shot(page, args, "5-ort")

    section("Handy: Hier suchen (Kartenausschnitt)")
    page.mouse.move(195, 300)
    page.mouse.down()
    page.mouse.move(-5, 450, steps=12)  # weit genug, damit "Hier suchen" erscheint
    page.mouse.up()
    here = page.locator("#here-btn")
    here.wait_for(state="visible", timeout=5000)
    here.click()
    page.wait_for_function("document.querySelector('#sheet-title').textContent === 'Im Kartenausschnitt'", timeout=5000)
    page.wait_for_function("!document.querySelector('#sheet-sub').textContent.startsWith('Suche')", timeout=30000)
    page.wait_for_timeout(500)
    # Stationen per Web-Mercator in Bildschirmpixel umrechnen (Kartenmitte/Zoom speichert die App in localStorage)
    outside = page.evaluate("""() => {
        const view = JSON.parse(localStorage.getItem('refill:view'));
        const scale = 256 * 2 ** view.zoom;
        const merc = (lat, lng) => [(lng + 180) / 360 * scale,
            (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * scale];
        const [cx, cy] = merc(view.lat, view.lng);
        const m = document.getElementById('map').getBoundingClientRect();
        const top = document.querySelector('.topbar').getBoundingClientRect().bottom + 8;
        const bottom = document.getElementById('sheet').getBoundingClientRect().top;
        return [...document.querySelectorAll('.list .item')].map(li => {
            const [x, y] = merc(+li.dataset.lat, +li.dataset.lng);
            return [Math.round(x - cx + m.width / 2), Math.round(y - cy + m.height / 2)];
        }).filter(([x, y]) => x < -2 || x > m.width + 2 || y < top - 2 || y > bottom + 2);
    }""")
    listed = page.locator(".list .item").count()
    check(listed > 0, "Ausschnitt-Suche findet Stationen", page.inner_text("#sheet-sub"))
    check(not outside, "Alle gelisteten Stationen liegen im sichtbaren Kartenbereich", f"außerhalb (px): {outside}")
    shot(page, args, "5b-ausschnitt")

    section("Handy: Standort-Knopf")
    page.click("#locate-btn")
    page.wait_for_function("document.querySelector('#sheet-title').textContent === 'In deiner Nähe'", timeout=10000)
    page.wait_for_function("!document.querySelector('#sheet-sub').textContent.startsWith('Suche')", timeout=30000)
    page.wait_for_timeout(1500)
    check(abs(user_offset(page)) < 3, "Standort-Knopf zentriert die Karte auf den Standort", f"Abstand zur Mitte: {user_offset(page)} px")

    if args.full:
        section("Handy: Alle Stationen speichern")
        page.click("#menu-btn")
        page.click("#offline-btn")
        page.wait_for_selector('#toast:has-text("gespeichert")', timeout=180000)
        total = int(re.sub(r"\D", "", page.inner_text("#toast").split(" ")[0]))
        check(total > 5000, "Komplett-Download speichert alle Stationen", f"{total}")
        page.keyboard.press("Escape")

    section("Handy: Service Worker und Offline-Start")
    page.evaluate("navigator.serviceWorker.ready.then(() => true)")
    check(page.evaluate("!!navigator.serviceWorker.controller"), "Service Worker steuert die Seite")
    console.offline = True
    context.set_offline(True)
    page.reload()
    page.wait_for_selector(".list .item", timeout=20000)
    page.wait_for_timeout(800)
    check(page.is_visible("#offline-badge"), "Offline-Hinweis sichtbar")
    check(page.locator(".list .item").count() > 0, "Liste kommt offline aus dem Speicher")
    shot(page, args, "6-offline")
    context.set_offline(False)

    check(not console.errors, "Keine JavaScript-Fehler", "\n    ".join(console.errors))
    context.close()
    return station_hash


def test_fresh_visitor(browser, base, station_hash, args):
    section("Erstbesuch ohne Standortfreigabe")
    context = browser.new_context(**PHONE)
    page = context.new_page()
    console = ConsoleWatcher(page)
    page.goto(base)
    page.wait_for_selector(".empty-state", timeout=10000)
    check(page.locator(".empty-state button", has_text="Standort").count() == 1, "Startbildschirm bietet Standortfreigabe an")

    section("Deep-Link auf eine Station ohne Vorwissen")
    page2 = context.new_page()
    console2 = ConsoleWatcher(page2)
    page2.goto(f"{base}{station_hash}")
    page2.wait_for_selector("#view-detail .facts", timeout=20000)
    check(bool(page2.inner_text("#view-detail h2").strip()), "Station wird geladen und angezeigt")
    page2.wait_for_timeout(1000)
    shot(page2, args, "7-deeplink")
    check(not console.errors + console2.errors, "Keine JavaScript-Fehler", "\n    ".join(console.errors + console2.errors))
    context.close()


def test_desktop(browser, base, args):
    section("Desktop im Dark Mode")
    context = browser.new_context(viewport={"width": 1366, "height": 820}, color_scheme="dark", locale="de-DE",
                                  geolocation=BERLIN, permissions=["geolocation"])
    page = context.new_page()
    console = ConsoleWatcher(page)
    page.goto(base)
    page.wait_for_selector(".list .item .item-meta", timeout=30000)
    width = page.locator("#sheet").bounding_box()["width"]
    check(abs(width - 400) < 1, "Liste wird zur Seitenleiste", f"{width}px")
    check(page.locator(".leaflet-control-zoom").count() == 1, "Zoom-Knöpfe auf dem Desktop")
    page.wait_for_timeout(1500)
    shot(page, args, "8-desktop-dunkel")
    check(not console.errors, "Keine JavaScript-Fehler", "\n    ".join(console.errors))
    context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--install", action="store_true", help="Chromium für Playwright herunterladen und beenden")
    parser.add_argument("--headed", action="store_true", help="Browser sichtbar starten")
    parser.add_argument("--screenshots", metavar="DIR", help="Screenshots in DIR ablegen")
    parser.add_argument("--full", action="store_true", help="auch den Komplett-Download testen")
    args = parser.parse_args()

    if args.install:
        return subprocess.call([sys.executable, "-m", "playwright", "install", "chromium"])
    if args.screenshots:
        Path(args.screenshots).mkdir(parents=True, exist_ok=True)

    with serve() as base, sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=not args.headed)
        except PlaywrightError as err:
            print(f"Chromium startet nicht:\n{err}\n")
            print("Abhilfe: uv run tests/e2e.py --install   und ggf.   sudo apt install libnss3")
            return 2
        test_unit(browser, base)
        station_hash = test_mobile(browser, base, args)
        test_fresh_visitor(browser, base, station_hash, args)
        test_desktop(browser, base, args)
        browser.close()

    print(f"\n{'Alle Prüfungen bestanden.' if not failures else f'{len(failures)} Prüfung(en) fehlgeschlagen:'}")
    for f in failures:
        print(f"  - {f}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
