# /// script
# requires-python = ">=3.12"
# dependencies = ["playwright==1.64.1"]
# ///
"""Rendert die PNG-Icons aus icons/icon.svg.

Einmalig:  uv run tests/e2e.py --install   (lädt Chromium für dieselbe Playwright-Version)
Aufruf:    uv run tools/make_icons.py
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ICONS = Path(__file__).resolve().parent.parent / "icons"
SVG = (ICONS / "icon.svg").read_text()
# Maskable- und Apple-Icons: randlos, weil das System selbst abrundet bzw. maskiert.
SQUARE = SVG.replace(' rx="112"', "")

TARGETS = [
    ("icon-192.png", 192, SVG),
    ("icon-512.png", 512, SVG),
    ("maskable-512.png", 512, SQUARE),
    ("apple-touch-icon.png", 180, SQUARE),
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, size, svg in TARGETS:
        page = browser.new_page(viewport={"width": size, "height": size})
        sized = svg.replace("<svg ", f'<svg width="{size}" height="{size}" ', 1)
        page.set_content(f'<style>html,body{{margin:0;background:transparent}}svg{{display:block}}</style>{sized}')
        page.screenshot(path=str(ICONS / name), omit_background=True)
        page.close()
        print("geschrieben:", name)
    browser.close()
