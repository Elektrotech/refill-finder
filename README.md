# Refill-Finder

Mobile-first Web-App (PWA), mit der man schnell die nächsten [Refill-Stationen](https://refill-deutschland.de/) findet – Orte, an denen man seine Flasche kostenlos mit Leitungswasser auffüllen kann.

Die offizielle Karte auf refill-deutschland.de ist ein eingebettetes iframe von [Karte von Morgen](https://www.kartevonmorgen.org/) (Tag `refill-station`). Diese App nutzt dieselben Daten direkt über die öffentliche OpenFairDB-API (Lizenz CC0), braucht also kein eigenes Backend.

## Funktionen

- **Nächste Stationen zuerst:** Standort freigeben → Liste sortiert nach Entfernung mit Gehzeit; die Karte zoomt auf die nächsten Treffer.
- **Öffnungsstatus:** „Geöffnet bis 18:00“ / „Geschlossen · öffnet morgen 10:00“. Die Öffnungszeiten sind bei Karte von Morgen Freitext; `js/hours.js` versteht OSM-Syntax und gängige deutsche Schreibweisen. Ist ein Text nicht eindeutig, wird er unverändert angezeigt statt einen falschen Status zu behaupten (bei echten Daten werden ca. ⅔ erkannt).
- **Filter:** Jetzt geöffnet, Trinkbrunnen, Barrierefrei.
- **Ortssuche** (Photon/OpenStreetMap) und „Hier suchen“ nach dem Verschieben der Karte.
- **Detailansicht** mit Route (Apple Karten auf iOS, sonst Google Maps, jeweils zu Fuß), Anrufen, Website, Teilen, Adresse, Wochenübersicht und Link zum Korrigieren bei Karte von Morgen.
- **Bedienung am Handy:** Bottom-Sheet mit drei Rastpunkten (wischen oder antippen), große Touch-Ziele, Zurück-Taste schließt die Detailansicht. Ab 800 px Breite wird das Sheet zur Seitenleiste.
- **PWA:** installierbar, App-Shell offline, angesehene Kartenkacheln werden gecacht (max. 500), Stationen und Details liegen in IndexedDB. Im Info-Dialog lassen sich alle ~9.000 Stationen für unterwegs speichern.
- **Deep-Links:** `#/s/<id>` öffnet direkt eine Station (wird beim Teilen verwendet).
- Heller und dunkler Modus, `prefers-reduced-motion` wird respektiert.

## Lokal starten

Kein Build-Schritt, keine Abhängigkeiten – nur statische Dateien:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Standortabfrage und Service Worker funktionieren nur über `https://` oder `localhost`. Zum Testen auf dem Handy also entweder deployen oder einen HTTPS-Tunnel verwenden.

## Deployment

**GitHub Pages (eingerichtet):** Jeder Push auf `main` veröffentlicht die App über `.github/workflows/pages.yml`. Einmalig im Repository unter *Settings → Pages → Build and deployment → Source* „GitHub Actions“ auswählen. Der Workflow
- kopiert nur die App-Dateien (ohne `tests/` und `tools/`) nach `_site/`,
- setzt `VERSION` in `sw.js` automatisch auf den Commit-Hash, damit installierte Apps jedes Update bekommen (nach dem Neuladen erscheint „Neue Version verfügbar – Aktualisieren“).

Die App liegt dann unter `https://<nutzer>.github.io/<repo>/` und funktioniert im Unterverzeichnis ohne Anpassungen.

**Anderes statisches Hosting** (Netlify, Cloudflare Pages, nginx …): einfach die Dateien ausliefern. Dort muss `VERSION` in `sw.js` bei jeder Änderung von Hand erhöht werden, weil der Service Worker die App-Shell cache-first ausliefert.

## Tests

**Unit-Tests ohne Installation:** `http://localhost:8000/tests/` im Browser öffnen – testet den Öffnungszeiten-Parser (`tests/hours.test.js`).

**End-to-End-Tests** mit [uv](https://docs.astral.sh/uv/) und Playwright. Die Abhängigkeiten stehen im Skript selbst (PEP 723), es gibt kein `requirements.txt` und keine venv im Projekt:

```bash
uv run tests/e2e.py --install   # einmalig: Chromium für die festgelegte Playwright-Version laden
sudo apt install libnss3        # einmalig, falls Chromium wegen fehlender Bibliotheken nicht startet

uv run tests/e2e.py                          # Unit-Tests + Handy-, Offline-, Deep-Link- und Desktop-Abläufe
uv run tests/e2e.py --screenshots shots/     # mit Screenshots
uv run tests/e2e.py --headed                 # Browser sichtbar
uv run tests/e2e.py --full                   # zusätzlich "Alle Stationen speichern" (~60 API-Anfragen)
```

Die E2E-Tests laufen gegen die Live-API und prüfen Verhalten (Sortierung, Filter, Offline-Start …), keine konkreten Stationen.

**Icons neu erzeugen** nach Änderungen an `icons/icon.svg`: `uv run tools/make_icons.py`

## Aufbau

```
index.html              Markup, Icon-Sprite, Info-Dialog
css/app.css             Layout (mobile-first), Hell/Dunkel über CSS-Variablen
js/app.js               UI: Karte, Bottom-Sheet, Liste, Details, Suche, Offline, Installation
js/api.js               Karte-von-Morgen-API (Suche per Bounding-Box, Details) und Photon-Geocoder
js/hours.js             Öffnungszeiten-Parser und Status
js/geo.js               Entfernungen, Bounding-Boxen, Formatierung
js/store.js             IndexedDB-Cache
sw.js                   Service Worker
manifest.webmanifest    PWA-Manifest
vendor/leaflet/         Leaflet 1.9.4 (lokal, damit die App offline startet)
icons/                  App-Icons; PNGs werden mit tools/make_icons.py aus icon.svg erzeugt
```

### Wie die Umkreissuche funktioniert

Die Such-API liefert höchstens 2000 Einträge pro Anfrage und sortiert nicht nach Entfernung. Deshalb fragt die App wachsende Boxen um den Standort ab (1 km, 2,5 km, 5 km … 200 km), bis mindestens 25 passende Stationen im Radius liegen. Danach werden die 50 nächsten sortiert und ihre Details (Adresse, Öffnungszeiten) in einem Sammelaufruf nachgeladen. Bereits geladene Bereiche werden 10 Minuten lang nicht erneut abgefragt; Stationen, die upstream gelöscht wurden, verschwinden beim nächsten vollständigen Laden des Bereichs aus dem lokalen Cache.

## Datenquellen und Nutzungsbedingungen

- Stationen: [Karte von Morgen / OpenFairDB](https://github.com/kartevonmorgen/openfairdb), CC0. Inhalte pflegt die Initiative Refill Deutschland (a tip: tap e.V.) und die Community.
- Karte: © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende, Kacheln von `tile.openstreetmap.org`. Deren [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) erlaubt keinen stark frequentierten Dauerbetrieb – bei größerer Nutzerzahl einen eigenen bzw. kommerziellen Kachelanbieter eintragen (`L.tileLayer` in `js/app.js` und die Host-Prüfung in `sw.js`).
- Ortssuche: [Photon](https://photon.komoot.io/) von komoot (Fair-Use; für hohe Last selbst hosten).

Dies ist eine inoffizielle App und steht in keiner Verbindung zu Refill Deutschland.
