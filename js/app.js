import { parseHours, hoursStatus, weekTable } from './hours.js';
import { distance, bboxAround, bboxContains, inBBox, formatDistance, formatWalk } from './geo.js';
import * as api from './api.js';
import * as store from './store.js';

const L = window.L;
const $ = sel => document.querySelector(sel);
const root = document.documentElement;
const SVG_NS = 'http://www.w3.org/2000/svg';

const NEARBY_WANT = 25;        // so viele Treffer suchen wir mindestens im Umkreis
const LIST_MAX = 50;           // Länge der Liste (= Details, die vorab geladen werden)
const RADII = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 200000];
const MAP_LOAD_MIN_ZOOM = 10;  // darunter werden beim Verschieben keine neuen Stationen geladen
const BOX_TTL = 10 * 60 * 1000;
const DETAILS_TTL = 24 * 60 * 60 * 1000;
const OPEN_MAP_MAX = 150;      // "Jetzt geöffnet" auf der Karte: höchstens so viele Details (3 Anfragen) nachladen
const DEFAULT_VIEW = { lat: 51.16, lng: 10.45, zoom: 6 };
let userMovedMap = false;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const desktopQuery = matchMedia('(min-width: 800px)');
const isDesktop = () => desktopQuery.matches;

const state = {
  stations: new Map(),   // id -> kompakte Station
  details: new Map(),    // id -> Details
  ref: null,             // Bezugspunkt der Liste: {lat, lng, kind: 'gps' | 'place' | 'map', label, bounds?, zoom?}
  user: null,            // {lat, lng, accuracy}
  filters: { open: false, fountain: false, accessible: false },
  nearby: [],            // [{s, d}] sortiert nach Entfernung
  nearbyTotal: 0,        // Treffer insgesamt (im Kartenausschnitt evtl. mehr als angezeigt)
  loading: false,
  selected: null,
  offline: !navigator.onLine,
  loadedBoxes: [],       // [{box, t}] vollständig geladene Bereiche
};

/* ---------- Hilfsfunktionen ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...compact(children));
  return node;
}

/** Verschachtelte Kinder-Listen glätten und leere Werte (null, false, '') entfernen. */
function compact(children) {
  return children.flat(Infinity).filter(c => c != null && c !== false && c !== '');
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function safeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

const local = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`refill:${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`refill:${key}`, JSON.stringify(value)); } catch { /* privater Modus */ }
  },
};

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

let toastTimer;
function toast(message, { action, onAction, duration = 4500 } = {}) {
  const t = $('#toast');
  t.replaceChildren(el('span', { text: message }));
  if (action) {
    t.append(el('button', { type: 'button', text: action, onclick: () => { t.hidden = true; onAction(); } }));
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  if (duration) toastTimer = setTimeout(() => { t.hidden = true; }, duration);
}

const plural = (n, one, many) => `${n.toLocaleString('de-DE')} ${n === 1 ? one : many}`;

/* ---------- Karte ---------- */

const savedView = local.get('view', DEFAULT_VIEW);
const map = L.map('map', {
  zoomControl: false,
  attributionControl: false,
  worldCopyJump: true,
  minZoom: 3,
}).setView([savedView.lat, savedView.lng], savedView.zoom);

L.control.attribution({
  position: isDesktop() ? 'bottomright' : 'topright',
  prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>',
}).addTo(map);
if (isDesktop()) L.control.zoom({ position: 'topright', zoomInTitle: 'Hineinzoomen', zoomOutTitle: 'Herauszoomen' }).addTo(map);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  crossOrigin: true, // CORS statt "opaque", damit der Service Worker Kacheln platzsparend cachen kann
  attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · '
    + 'Stationen: <a href="https://www.kartevonmorgen.org/" target="_blank" rel="noopener">Karte von Morgen</a>',
}).addTo(map);

// Stationen werden als Wassertropfen direkt auf das Canvas gezeichnet: schnell bei tausenden Markern
// und klar vom runden Standort-Punkt zu unterscheiden. Die Tropfenspitze zeigt nach oben.
const DROP_TIP = 1.8;
L.Canvas.include({
  _updateDrop(layer) {
    if (!this._drawing || layer._empty()) return;
    const { x, y } = layer._point;
    const r = Math.max(Math.round(layer._radius), 1);
    const a = Math.asin(1 / DROP_TIP);
    const ctx = this._ctx;
    ctx.beginPath();
    ctx.moveTo(x, y - r * DROP_TIP);
    ctx.arc(x, y, r, -a, Math.PI + a, false);
    ctx.closePath();
    this._fillStroke(ctx, layer);
  },
});
const DropMarker = L.CircleMarker.extend({
  _updatePath() {
    this._renderer._updateDrop(this);
  },
  _updateBounds() {
    const r = this._radius, w = this._clickTolerance();
    this._pxBounds = new L.Bounds(this._point.subtract([r + w, r * DROP_TIP + w]), this._point.add([r + w, r + w]));
  },
});

const renderer = L.canvas({ padding: 0.3, tolerance: 8 });
const markerLayer = L.layerGroup().addTo(map);
const markers = new Map();
const canHover = matchMedia('(hover: hover)').matches;
let colors = readColors();

function readColors() {
  const cs = getComputedStyle(root);
  return {
    primary: cs.getPropertyValue('--primary').trim(),
    fountain: cs.getPropertyValue('--fountain').trim(),
    ring: cs.getPropertyValue('--text').trim(),
  };
}

function markerStyle(s, selected) {
  const small = map.getZoom() < 11;
  return {
    renderer,
    radius: selected ? 10 : small ? 4.5 : 7,
    color: selected ? colors.ring : '#ffffff',
    weight: selected ? 3 : small ? 1.5 : 2,
    fillColor: s.fountain ? colors.fountain : colors.primary,
    fillOpacity: 1,
    opacity: 1,
  };
}

const matchesStatic = s => (!state.filters.fountain || s.fountain) && (!state.filters.accessible || s.accessible);
// "Jetzt geöffnet" braucht die Öffnungszeiten aus den Details; ohne sie gilt eine Station als nicht geöffnet.
const matchesMap = s => matchesStatic(s) && (!state.filters.open || !!statusFor(s)?.open);

function syncMarkers() {
  for (const s of state.stations.values()) {
    let m = markers.get(s.id);
    if (s.id !== state.selected && !matchesMap(s)) {
      if (m) markerLayer.removeLayer(m);
      continue;
    }
    if (!m) {
      m = new DropMarker([s.lat, s.lng], markerStyle(s, s.id === state.selected));
      m.on('click', () => openDetail(s.id));
      if (canHover) m.bindTooltip(s.title, { direction: 'top', offset: [0, -8] });
      markers.set(s.id, m);
    }
    if (!markerLayer.hasLayer(m)) markerLayer.addLayer(m);
  }
  markers.get(state.selected)?.bringToFront();
}

function removeStations(ids) {
  for (const id of ids) {
    state.stations.delete(id);
    const m = markers.get(id);
    if (m) markerLayer.removeLayer(m);
    markers.delete(id);
  }
}

function restyleMarkers() {
  for (const [id, m] of markers) m.setStyle(markerStyle(state.stations.get(id), id === state.selected));
  markers.get(state.selected)?.bringToFront();
}

function setSelectedMarker(id) {
  const prev = state.selected;
  state.selected = id;
  for (const x of [prev, id]) {
    const s = state.stations.get(x);
    if (s && markers.has(x)) markers.get(x).setStyle(markerStyle(s, x === id));
  }
  syncMarkers(); // die gewählte Station ist immer sichtbar, auch wenn sie nicht zu den Filtern passt
}

let userMarker = null;
let userCircle = null;
function showUser() {
  const { lat, lng, accuracy } = state.user;
  if (!userMarker) {
    userCircle = L.circle([lat, lng], {
      radius: accuracy, interactive: false, weight: 1, color: '#1a73e8', fillColor: '#1a73e8', fillOpacity: 0.08,
    }).addTo(map);
    userMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: 'user-loc', html: '<span class="user-halo"></span><span class="user-dot"></span>', iconSize: [18, 18] }),
      interactive: false, keyboard: false, zIndexOffset: 1000,
    }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lng]);
    userCircle.setLatLng([lat, lng]).setRadius(accuracy);
  }
}

let refMarker = null;
function showRefMarker() {
  refMarker?.remove();
  refMarker = null;
  if (state.ref?.kind !== 'place') return;
  refMarker = L.marker([state.ref.lat, state.ref.lng], {
    icon: L.divIcon({
      className: 'ref-pin',
      html: '<svg viewBox="0 0 24 24"><path d="M12 22.5s-7.5-6.3-7.5-12.5a7.5 7.5 0 0 1 15 0c0 6.2-7.5 12.5-7.5 12.5Z" stroke-width="1.5"/><circle cx="12" cy="10" r="2.6" fill="#fff" stroke="none"/></svg>',
      iconSize: [34, 34],
      iconAnchor: [17, 33],
    }),
    interactive: false, keyboard: false,
  }).addTo(map);
}

/* Die Karte liegt teilweise unter Suchleiste und Sheet; diese Helfer zentrieren auf den sichtbaren Teil. */
const topInset = () => (isDesktop() ? 0 : $('.topbar').getBoundingClientRect().bottom + 8);
const bottomInset = () => (isDesktop() ? 0 : Math.max(0, window.innerHeight - sheetY));

function visibleCenter() {
  const size = map.getSize();
  return map.containerPointToLatLng([size.x / 2, (topInset() + size.y - bottomInset()) / 2]);
}

// Bewegungen, die die App selbst auslöst, sollen den "Hier suchen"-Knopf nicht einblenden.
let programmaticMove = false;
let programmaticTimer;
function markProgrammatic() {
  programmaticMove = true;
  clearTimeout(programmaticTimer);
  programmaticTimer = setTimeout(() => { programmaticMove = false; }, 1500);
}

/** Der tatsächlich sichtbare Kartenbereich (ohne Suchleiste und Sheet) als Bounding-Box. */
function visibleBounds() {
  const size = map.getSize();
  const nw = map.containerPointToLatLng([0, topInset()]);
  const se = map.containerPointToLatLng([size.x, Math.max(topInset() + 1, size.y - bottomInset())]);
  return { south: se.lat, west: nw.lng, north: nw.lat, east: se.lng };
}

function panToVisible(latlng, zoom) {
  markProgrammatic();
  const z = zoom ?? map.getZoom();
  const shift = (bottomInset() - topInset()) / 2;
  const target = map.unproject(map.project(latlng, z).add([0, shift]), z);
  map.flyTo(target, z, { animate: !reduceMotion, duration: 0.6 });
}

function fitVisible(bounds) {
  markProgrammatic();
  map.flyToBounds(bounds, {
    paddingTopLeft: [32, topInset() + 24],
    paddingBottomRight: [32, bottomInset() + 24],
    maxZoom: 16,
    animate: !reduceMotion,
    duration: 0.7,
  });
}

/* ---------- Bottom Sheet (Handy) ---------- */

const sheet = $('#sheet');
const sheetHead = $('#sheet-head');
const sheetBody = $('#sheet-body');
let snap = 'half';
let sheetY = 0;

function snapY(name) {
  const h = window.innerHeight;
  if (name === 'full') return Math.round(topInset());
  if (name === 'half') return Math.round(h * 0.48);
  const peek = sheetHead.offsetHeight + (state.selected ? 96 : 76);
  return Math.round(h - Math.min(peek, h * 0.45));
}

function applySheetY(y, { pad = true } = {}) {
  sheetY = y;
  root.style.setProperty('--sheet-y', `${y}px`);
  if (pad) root.style.setProperty('--sheet-pad', `${y}px`);
}

function setSnap(name) {
  snap = name;
  document.body.dataset.snap = name;
  if (isDesktop()) {
    root.style.removeProperty('--sheet-y');
    root.style.removeProperty('--sheet-pad');
    sheetY = window.innerHeight;
    return;
  }
  applySheetY(snapY(name));
}

/** Snap durch Ziehen/Antippen: Gibt das Sheet mehr Karte frei, die gewählte Station wieder mittig zeigen. */
function userSnap(name) {
  const before = snapY(snap); // nicht sheetY: das steht beim Ziehen schon auf der Fingerposition
  setSnap(name);
  const s = state.selected && state.stations.get(state.selected);
  if (s && sheetY > before) panToVisible([s.lat, s.lng]);
}

(function setupSheetDrag() {
  let startY = 0, startSheetY = 0, dragging = false;
  let lastY = 0, lastT = 0, velocity = 0;

  // Bewegungen auf window verfolgen: Mauszeiger verlassen den Kopfbereich beim Ziehen sofort.
  const move = e => {
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(dy) < 6) return;
      dragging = true;
      document.body.classList.add('dragging');
    }
    const y = Math.min(snapY('peek'), Math.max(snapY('full'), startSheetY + dy));
    const dt = e.timeStamp - lastT;
    if (dt > 0) velocity = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = e.timeStamp;
    applySheetY(y, { pad: false });
  };

  const end = e => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (!dragging) {
      // Tipp auf Griff/Titel: Sheet weiter aufziehen bzw. auf halbe Höhe zurück
      if (e.type === 'pointerup' && !e.target.closest('button, a')) userSnap(snap === 'half' ? 'full' : 'half');
      return;
    }
    dragging = false;
    document.body.classList.remove('dragging');
    const projected = sheetY + velocity * 180;
    const options = ['full', 'half', 'peek'].map(n => [n, Math.abs(snapY(n) - projected)]);
    options.sort((a, b) => a[1] - b[1]);
    userSnap(options[0][0]);
  };

  sheetHead.addEventListener('pointerdown', e => {
    if (isDesktop() || (e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('.chips')) return;
    dragging = false;
    startY = lastY = e.clientY;
    lastT = e.timeStamp;
    startSheetY = sheetY;
    velocity = 0;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
})();

/* ---------- Daten laden ---------- */

function mergeStations(list, removeIds = []) {
  removeStations(removeIds);
  for (const s of list) state.stations.set(s.id, s);
  syncMarkers();
  store.putStations(list, removeIds);
}

/** Lädt alle Stationen einer Box, sofern sie nicht kürzlich schon vollständig geladen wurde. */
async function loadBox(box, { signal } = {}) {
  const now = Date.now();
  state.loadedBoxes = state.loadedBoxes.filter(x => now - x.t < BOX_TTL);
  if (state.loadedBoxes.some(x => bboxContains(x.box, box))) return;
  const { stations, truncated } = await api.searchBBox(box, { signal });
  setOffline(false);
  let removed = [];
  if (!truncated) {
    // Lokal gespeicherte Stationen, die es in diesem Bereich nicht mehr gibt, entfernen
    const ids = new Set(stations.map(s => s.id));
    removed = [...state.stations.values()].filter(s => inBBox(box, s) && !ids.has(s.id)).map(s => s.id);
    state.loadedBoxes.push({ box, t: now });
  }
  mergeStations(stations, removed);
}

async function ensureDetails(ids) {
  const missing = ids.filter(id => !state.details.has(id));
  if (missing.length) for (const d of await store.getDetails(missing)) state.details.set(d.id, d);
  const stale = ids.filter(id => {
    const d = state.details.get(id);
    return !d || Date.now() - d.fetched > DETAILS_TTL;
  });
  if (!stale.length || !navigator.onLine) {
    if (missing.length && state.filters.open) syncMarkers();
    return;
  }
  try {
    const fresh = await api.fetchDetails(stale);
    for (const d of fresh) state.details.set(d.id, d);
    store.putDetails(fresh);
  } catch (err) {
    console.warn('Details konnten nicht geladen werden', err);
  }
  if (state.filters.open) syncMarkers();
}

const hoursCache = new Map();
function statusFor(s) {
  const d = state.details.get(s.id);
  const text = d?.openingHours || '';
  let entry = hoursCache.get(s.id);
  if (!entry || entry.text !== text) {
    entry = { text, parsed: parseHours(text) };
    hoursCache.set(s.id, entry);
  }
  if (entry.parsed) {
    const st = hoursStatus(entry.parsed);
    return { ...st, cls: st.open ? (st.soon ? 'soon' : 'open') : 'closed' };
  }
  if (s.fountain && d && !text) return { open: true, cls: 'public', text: 'Öffentlich zugänglich' };
  return null;
}

/* ---------- Umkreissuche ---------- */

let nearbySeq = 0;

function computeNearby() {
  if (!state.ref) { state.nearby = []; state.nearbyTotal = 0; return; }
  const area = state.ref.bounds;
  // Im Kartenausschnitt zählt die Entfernung zum Nutzer (falls bekannt), sonst zum Bezugspunkt.
  const from = area && state.user ? state.user : state.ref;
  const rows = [...state.stations.values()]
    .filter(s => matchesStatic(s) && (!area || inBBox(area, s)))
    .map(s => ({ s, d: distance(from, s) }))
    .sort((a, b) => a.d - b.d);
  state.nearbyTotal = rows.length;
  state.nearby = rows.slice(0, LIST_MAX);
}

/** Lädt wachsende Boxen um `ref`, bis genug passende Stationen im Radius liegen. */
async function loadAround(ref, cancelled) {
  for (const r of RADII) {
    await loadBox(bboxAround(ref, r));
    if (cancelled()) return;
    let count = 0;
    for (const s of state.stations.values()) if (matchesStatic(s) && distance(ref, s) <= r) count++;
    if (count >= NEARBY_WANT) return;
  }
}

async function findNearby({ fit = true } = {}) {
  const seq = ++nearbySeq;
  const ref = state.ref;
  state.loading = true;
  computeNearby();
  renderList();

  let failed = !navigator.onLine;
  if (!failed) {
    try {
      if (ref.bounds) await loadBox(ref.bounds);
      else await loadAround(ref, () => seq !== nearbySeq);
    } catch (err) {
      console.warn('Suche fehlgeschlagen', err);
      failed = true;
    }
  }
  if (seq !== nearbySeq) return;
  if (failed) setOffline(true);

  state.loading = false;
  computeNearby();
  renderList();
  if (fit && !state.selected) fitNearby();

  await ensureDetails(state.nearby.map(r => r.s.id));
  if (seq === nearbySeq) renderList();
}

function fitNearby() {
  if (!state.ref) return;
  const pts = state.nearby.slice(0, 5).map(r => [r.s.lat, r.s.lng]);
  if (!pts.length) {
    panToVisible([state.ref.lat, state.ref.lng], 13);
    return;
  }
  pts.push([state.ref.lat, state.ref.lng]);
  fitVisible(L.latLngBounds(pts));
}

function setRef(ref, { fit = true } = {}) {
  state.ref = ref;
  showRefMarker();
  $('#here-btn').hidden = true;
  $('#locate-btn').classList.toggle('active', ref.kind === 'gps');
  if (state.selected) closeDetail();
  // Beim Kartenausschnitt bleibt das Sheet unten, sonst würde es einen Teil des Ausschnitts verdecken.
  if (!isDesktop() && snap === 'peek' && ref.kind !== 'map') setSnap('half');
  findNearby({ fit });
}

/* ---------- Standort ---------- */

let watchId = null;
let locating = false;

function locate({ quiet = false } = {}) {
  const btn = $('#locate-btn');
  if (!('geolocation' in navigator)) {
    if (!quiet) toast('Dein Browser kann den Standort nicht bestimmen. Suche stattdessen oben nach einem Ort.');
    return;
  }
  if (locating) return;
  locating = true;
  btn.setAttribute('aria-busy', 'true');
  navigator.geolocation.getCurrentPosition(pos => {
    locating = false;
    btn.removeAttribute('aria-busy');
    local.set('located', true);
    onPosition(pos, true);
    startWatch();
  }, err => {
    locating = false;
    btn.removeAttribute('aria-busy');
    if (err.code === err.PERMISSION_DENIED) local.set('located', false);
    if (!quiet) {
      toast(err.code === err.PERMISSION_DENIED
        ? 'Standortzugriff nicht erlaubt. Suche stattdessen oben nach einem Ort.'
        : 'Standort konnte nicht bestimmt werden. Bitte erneut versuchen.');
    }
    renderList();
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

function onPosition(pos, explicit) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  state.user = { lat, lng, accuracy };
  showUser();
  if (explicit) {
    setRef({ lat, lng, kind: 'gps', label: 'deinem Standort' });
  } else if (state.ref?.kind === 'gps') {
    if (distance(state.ref, state.user) > 400) {
      setRef({ lat, lng, kind: 'gps', label: 'deinem Standort' }, { fit: false });
    } else {
      // kleine Bewegungen: nur Entfernungen neu sortieren, ohne neue Anfrage
      state.ref = { ...state.ref, lat, lng };
      computeNearby();
      renderList();
    }
  } else if (state.ref?.bounds) {
    computeNearby(); // Entfernungen im Kartenausschnitt beziehen sich auf den Nutzer
    renderList();
  }
}

function startWatch() {
  if (watchId != null || !('geolocation' in navigator)) return;
  watchId = navigator.geolocation.watchPosition(pos => onPosition(pos, false), () => {}, {
    enableHighAccuracy: true, maximumAge: 15000,
  });
}

function stopWatch() {
  if (watchId == null) return;
  navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopWatch();
  else if (state.user) startWatch();
});

$('#locate-btn').addEventListener('click', () => {
  if (state.ref?.kind === 'gps' && state.user) {
    if (state.selected) closeDetail();
    fitNearby();
  } else {
    locate();
  }
});

/* ---------- Liste ---------- */

function refLabel() {
  if (!state.ref) return '';
  if (state.ref.kind === 'gps') return 'In deiner Nähe';
  if (state.ref.kind === 'place') return `Nahe ${state.ref.label}`;
  return 'Im Kartenausschnitt';
}

function renderHeader(shownCount) {
  $('#sheet-title').textContent = state.ref ? refLabel() : 'Wasser in der Nähe';
  const sub = $('#sheet-sub');
  if (!state.ref) sub.textContent = 'Kostenlos Leitungswasser auffüllen';
  else if (state.loading && !state.nearby.length) sub.textContent = 'Suche Refill-Stationen …';
  else if (!shownCount) sub.textContent = 'Keine passenden Stationen gefunden';
  else if (state.ref.bounds) {
    const n = state.filters.open ? shownCount : state.nearbyTotal;
    sub.textContent = `${plural(n, 'Station', 'Stationen')} im sichtbaren Bereich`
      + (state.user ? ` · nächste ${formatDistance(state.nearby[0].d)} von dir` : '');
  } else sub.textContent = `${plural(shownCount, 'Station', 'Stationen')} · nächste ${formatDistance(state.nearby[0].d)} entfernt`;
}

function itemNode({ s, d }) {
  const det = state.details.get(s.id);
  const address = det ? [det.street, det.city].filter(Boolean).join(', ') : '';
  const st = statusFor(s);
  const walk = formatWalk(d);
  return el('li', { class: `item${s.id === state.selected ? ' selected' : ''}`, 'data-id': s.id, 'data-lat': s.lat, 'data-lng': s.lng },
    el('button', { type: 'button', class: 'item-btn', onclick: () => openDetail(s.id) },
      el('span', { class: `type-icon${s.fountain ? ' fountain' : ''}` }, icon(s.fountain ? 'fountain' : 'drop')),
      el('span', { class: 'item-main' },
        el('span', { class: 'item-title', text: s.title }),
        address && el('span', { class: 'item-meta', text: address }),
        st && el('span', { class: `status ${st.cls}`, text: st.text }),
      ),
      el('span', { class: 'item-dist' },
        el('b', { text: formatDistance(d) }),
        walk && el('small', { text: walk }),
      ),
    ),
  );
}

function emptyState() {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'big-icon' }, icon('drop')),
    el('h2', { text: 'Wo möchtest du auffüllen?' }),
    el('p', { text: 'Finde Cafés, Läden und Trinkbrunnen, an denen du deine Flasche kostenlos mit Leitungswasser füllen kannst.' }),
    el('button', { type: 'button', class: 'btn btn-primary', onclick: () => locate() }, icon('locate'), 'Meinen Standort verwenden'),
    el('p', { class: 'hint', text: 'oder oben nach einem Ort suchen' }),
  );
}

function skeleton() {
  return el('div', { 'aria-busy': 'true', 'aria-label': 'Wird geladen' },
    Array.from({ length: 4 }, () => el('div', { class: 'skeleton' },
      el('span', { class: 'sk-icon' }),
      el('span', { class: 'sk-lines' }, el('span'), el('span')),
      el('span'),
    )),
  );
}

function renderList() {
  const view = $('#view-list');
  if (!state.ref) {
    renderHeader(0);
    view.replaceChildren(emptyState());
    return;
  }
  if (state.loading && !state.nearby.length) {
    renderHeader(0);
    view.replaceChildren(skeleton());
    return;
  }

  let rows = state.nearby;
  let hidden = 0;
  if (state.filters.open) {
    rows = rows.filter(r => statusFor(r.s)?.open);
    hidden = state.nearby.length - rows.length;
  }
  renderHeader(rows.length);

  const notes = [];
  if (state.filters.open && hidden) {
    notes.push(el('p', { class: 'list-note', text: `${plural(hidden, 'Station', 'Stationen')} ausgeblendet – geschlossen oder ohne lesbare Öffnungszeiten.` }));
  }
  if (!rows.length) {
    const anyFilter = Object.values(state.filters).some(Boolean);
    notes.unshift(el('div', { class: 'empty-state' },
      el('h2', { text: 'Nichts gefunden' }),
      el('p', {
        text: anyFilter ? 'Mit den gewählten Filtern gibt es hier keine Station.'
          : state.ref.bounds ? 'Im sichtbaren Kartenbereich ist keine Refill-Station eingetragen.'
            : 'In diesem Umkreis ist keine Refill-Station eingetragen.',
      }),
      anyFilter && el('button', { type: 'button', class: 'btn', onclick: resetFilters, text: 'Filter zurücksetzen' }),
    ));
  } else if (state.loading) {
    notes.push(el('p', { class: 'list-note', text: 'Suche weitere Stationen …' }));
  } else if (state.ref.bounds && state.nearbyTotal > LIST_MAX) {
    notes.push(el('p', {
      class: 'list-note',
      text: `Angezeigt werden die ${LIST_MAX}, die ${state.user ? 'dir' : 'der Kartenmitte'} am nächsten sind. Zum Eingrenzen hineinzoomen.`,
    }));
  }
  if (state.offline) {
    notes.push(el('p', { class: 'list-note', text: 'Offline: Es werden gespeicherte Stationen angezeigt.' }));
  }
  view.replaceChildren(...compact([el('ul', { class: 'list' }, rows.map(itemNode)), notes]));
}

/* ---------- Filter ---------- */

function applyFilters() {
  for (const chip of document.querySelectorAll('.chip[data-filter]')) {
    chip.setAttribute('aria-pressed', String(state.filters[chip.dataset.filter]));
  }
  local.set('filters', state.filters);
  syncMarkers();
}

function resetFilters() {
  state.filters = { open: false, fountain: false, accessible: false };
  applyFilters();
  if (state.ref) findNearby({ fit: false });
}

for (const chip of document.querySelectorAll('.chip[data-filter]')) {
  chip.addEventListener('click', () => {
    const key = chip.dataset.filter;
    state.filters[key] = !state.filters[key];
    applyFilters();
    if (key === 'open') loadVisible();
    if (!state.ref) return;
    if (key === 'open') renderList();
    else findNearby({ fit: false });
  });
}

/* ---------- Detailansicht ---------- */

let listScroll = 0;
let pushedDetail = false;
const GENERIC_TAGS = /^(refill|leitungswasser|trinkwasser|kostenfrei|trinkwasser-kostenfrei|kostenfreitrinkwasser|hlnug|handlungsfeld)/;

function routeUrl(s) {
  const apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return apple
    ? `https://maps.apple.com/?daddr=${s.lat},${s.lng}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=walking`;
}

function stationUrl(id) {
  return `${location.origin}${location.pathname}#/s/${id}`;
}

async function share(s) {
  const url = stationUrl(s.id);
  const title = s.title;
  try {
    if (navigator.share) {
      await navigator.share({ title, text: `${title} – hier kannst du kostenlos Wasser auffüllen`, url });
    } else {
      await navigator.clipboard.writeText(url);
      toast('Link kopiert');
    }
  } catch (err) {
    if (err.name !== 'AbortError') toast('Teilen nicht möglich');
  }
}

function hoursFact(s, det) {
  const children = [];
  const st = statusFor(s);
  if (st) children.push(el('span', { class: `status ${st.cls}`, text: st.text }));
  const parsed = parseHours(det.openingHours);
  if (parsed) {
    const today = (new Date().getDay() + 6) % 7;
    children.push(el('table', { class: 'hours' }, el('tbody', {},
      weekTable(parsed).map(r => el('tr', { class: today >= r.from && today <= r.to ? 'today' : null },
        el('td', { text: r.days }), el('td', { text: r.hours }))),
    )));
  } else if (det.openingHours) {
    children.push(el('p', { class: 'raw-hours', text: det.openingHours }));
  } else if (!s.fountain) {
    children.push(el('span', { class: 'muted', text: 'Keine Öffnungszeiten angegeben' }));
  }
  if (s.fountain) {
    children.push(el('p', { class: 'hint', text: 'Öffentliche Trinkbrunnen sind oft nur von Frühjahr bis Herbst in Betrieb.' }));
  }
  return el('li', { class: 'fact' }, icon('clock'), el('div', {}, children));
}

function renderDetail(id) {
  const view = $('#view-detail');
  const s = state.stations.get(id);
  if (!s) {
    view.replaceChildren(el('p', { class: 'list-note', text: state.offline ? 'Diese Station ist offline nicht verfügbar.' : 'Station wird geladen …' }));
    return;
  }
  const det = state.details.get(id);
  const from = state.user || state.ref;
  const d = from ? distance(from, s) : null;
  const walk = d != null ? formatWalk(d) : null;
  const web = safeUrl(det?.homepage);
  const img = safeUrl(det?.imageUrl);

  const facts = [];
  if (det) {
    const addr = [det.street, [det.zip, det.city].filter(Boolean).join(' '), det.country && det.country !== 'Deutschland' ? det.country : '']
      .filter(Boolean);
    if (addr.length) facts.push(el('li', { class: 'fact' }, icon('pin'), el('div', {}, addr.map((line, i) => [i ? el('br') : null, line]))));
    facts.push(hoursFact(s, det));
    if (det.phone) facts.push(el('li', { class: 'fact' }, icon('phone'), el('a', { href: `tel:${det.phone.replace(/[^\d+]/g, '')}`, text: det.phone })));
    if (det.email && /^[^\s@]+@[^\s@]+$/.test(det.email)) facts.push(el('li', { class: 'fact' }, icon('mail'), el('a', { href: `mailto:${det.email}`, text: det.email })));
    if (web) facts.push(el('li', { class: 'fact' }, icon('globe'), el('a', { href: web.href, target: '_blank', rel: 'noopener', text: web.hostname.replace(/^www\./, '') })));
  }

  let description = null;
  if (det?.description && det.description !== det.title) {
    const long = det.description.length > 280 || det.description.split('\n').length > 5;
    const p = el('p', { class: `description${long ? ' clamped' : ''}`, text: det.description });
    const more = long && el('button', {
      type: 'button', class: 'more-btn', text: 'Mehr anzeigen',
      onclick: () => { p.classList.remove('clamped'); more.remove(); },
    });
    description = el('li', { class: 'fact' }, icon('info'), el('div', {}, p, more));
  }

  const tags = (det?.tags || []).filter(t => !GENERIC_TAGS.test(t)).slice(0, 12);

  view.replaceChildren(...compact([
    el('h2', { id: 'detail-title', text: det?.title || s.title }),
    el('div', { class: 'detail-type' },
      el('span', { class: `kind${s.fountain ? ' fountain' : ''}` }, icon(s.fountain ? 'fountain' : 'drop'), s.fountain ? 'Trinkbrunnen' : 'Refill-Station'),
      s.accessible && el('span', { class: 'kind' }, icon('access'), 'Barrierefrei'),
      d != null && el('span', { text: `${formatDistance(d)}${walk ? ` · ${walk} zu Fuß` : ''}` }),
    ),
    el('div', { class: 'actions' },
      el('a', { class: 'btn btn-primary', href: routeUrl(s), target: '_blank', rel: 'noopener' }, icon('route'), 'Route'),
      det?.phone && el('a', { class: 'btn', href: `tel:${det.phone.replace(/[^\d+]/g, '')}` }, icon('phone'), 'Anrufen'),
      web && el('a', { class: 'btn', href: web.href, target: '_blank', rel: 'noopener' }, icon('globe'), 'Website'),
      el('button', { type: 'button', class: 'btn', onclick: () => share(s) }, icon('share'), 'Teilen'),
    ),
    det
      ? el('ul', { class: 'facts' }, facts, description)
      : (state.offline ? el('p', { class: 'list-note', text: 'Adresse und Öffnungszeiten sind offline nicht verfügbar.' }) : skeleton()),
    img && el('img', { class: 'detail-image', src: img.href, alt: '', loading: 'lazy', onerror: e => e.target.remove() }),
    tags.length > 0 && el('div', { class: 'tags', 'aria-label': 'Schlagworte' }, tags.map(t => el('span', { class: 'tag', text: `#${t}` }))),
    el('p', { class: 'detail-foot' },
      'Angaben ohne Gewähr. Fehler entdeckt? ',
      el('a', { href: api.kvmUrl(id), target: '_blank', rel: 'noopener' }, 'Bei Karte von Morgen korrigieren', icon('external')),
    ),
  ]));
}

async function openDetail(id, { push = true } = {}) {
  const wasOpen = !!state.selected;
  if (!wasOpen) listScroll = sheetBody.scrollTop;
  setSelectedMarker(id);

  if (push) {
    if (wasOpen) history.replaceState({ s: id }, '', `#/s/${id}`);
    else history.pushState({ s: id }, '', `#/s/${id}`);
    pushedDetail = pushedDetail || !wasOpen;
  }

  $('#head-list').hidden = true;
  $('#head-detail').hidden = false;
  $('#view-list').hidden = true;
  $('#view-detail').hidden = false;
  sheet.setAttribute('aria-labelledby', 'detail-title');
  sheetBody.scrollTop = 0;
  renderDetail(id);
  // Auf halbe Höhe, damit die Station auf der Karte sichtbar ist (bei "full" bliebe kein Kartenbereich übrig)
  if (!isDesktop()) setSnap('half');

  let s = state.stations.get(id);
  if (s) panToVisible([s.lat, s.lng], Math.max(map.getZoom(), 15));

  await ensureDetails([id]);
  if (state.selected !== id) return;
  if (!s) {
    // Deep-Link auf eine noch unbekannte Station
    const det = state.details.get(id);
    if (det) {
      s = api.stationFromDetails(det);
      mergeStations([s]);
      setSelectedMarker(id);
      panToVisible([s.lat, s.lng], 16);
    }
  }
  renderDetail(id);
}

function closeDetail() {
  if (!state.selected) return;
  setSelectedMarker(null);
  $('#head-list').hidden = false;
  $('#head-detail').hidden = true;
  $('#view-detail').hidden = true;
  $('#view-list').hidden = false;
  sheet.setAttribute('aria-labelledby', 'sheet-title');
  renderList();
  sheetBody.scrollTop = listScroll;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

function leaveDetail() {
  if (pushedDetail) {
    pushedDetail = false;
    history.back(); // löst popstate → route() → closeDetail() aus
  } else {
    closeDetail();
  }
}

function route() {
  const m = location.hash.match(/^#\/s\/([A-Za-z0-9_-]+)$/);
  if (m) openDetail(m[1], { push: false });
  else {
    pushedDetail = false;
    closeDetail();
  }
}

$('#back-btn').addEventListener('click', leaveDetail);
window.addEventListener('popstate', route);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.selected && !document.querySelector('dialog[open]') && document.activeElement !== $('#q')) leaveDetail();
});

/* ---------- Ortssuche ---------- */

const q = $('#q');
const results = $('#search-results');
let searchAbort = null;
let searchItems = [];
let activeIndex = -1;

function showResults(items, message) {
  searchItems = items;
  activeIndex = -1;
  const nodes = items.map((r, i) => el('li', { role: 'option', id: `sr-${i}`, 'aria-selected': 'false' },
    el('button', { type: 'button', tabindex: '-1', onclick: () => chooseResult(r) },
      icon(r.locate ? 'locate' : 'pin'),
      el('span', {}, el('span', { class: 'name', text: r.name }), r.context && el('span', { class: 'context', text: r.context })),
    )));
  if (message) nodes.push(el('li', { class: 'empty', text: message }));
  results.replaceChildren(...nodes);
  results.hidden = !nodes.length;
  q.setAttribute('aria-expanded', String(!results.hidden));
}

function hideResults() {
  results.hidden = true;
  q.setAttribute('aria-expanded', 'false');
  q.removeAttribute('aria-activedescendant');
}

const LOCATE_ITEM = { locate: true, name: 'Mein Standort', context: 'Stationen in deiner Nähe anzeigen' };

function chooseResult(r) {
  hideResults();
  q.blur();
  if (r.locate) {
    q.value = '';
    $('#q-clear').hidden = true;
    locate();
    return;
  }
  q.value = r.name;
  $('#q-clear').hidden = false;
  setRef({ lat: r.lat, lng: r.lng, kind: 'place', label: r.name });
}

const runSearch = debounce(async text => {
  searchAbort?.abort();
  searchAbort = new AbortController();
  try {
    const items = await api.geocode(text, map.getCenter(), { signal: searchAbort.signal });
    if (q.value.trim() !== text) return;
    showResults(items, items.length ? null : 'Kein Ort gefunden');
  } catch (err) {
    if (err.name !== 'AbortError') showResults([], navigator.onLine ? 'Suche gerade nicht möglich' : 'Ortssuche braucht eine Internetverbindung');
  }
}, 300);

q.addEventListener('input', () => {
  const text = q.value.trim();
  $('#q-clear').hidden = !q.value;
  if (text.length < 3) {
    searchAbort?.abort();
    showResults(text ? [] : [LOCATE_ITEM]);
    return;
  }
  runSearch(text);
});

q.addEventListener('focus', () => {
  if (!q.value.trim()) showResults([LOCATE_ITEM]);
  if (!isDesktop() && snap !== 'peek') setSnap('peek');
});

q.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!searchItems.length) return;
    e.preventDefault();
    activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + searchItems.length) % searchItems.length;
    results.querySelectorAll('[role="option"]').forEach((li, i) => li.setAttribute('aria-selected', String(i === activeIndex)));
    q.setAttribute('aria-activedescendant', `sr-${activeIndex}`);
  } else if (e.key === 'Escape') {
    hideResults();
  }
});

$('#search-form').addEventListener('submit', e => {
  e.preventDefault();
  const r = searchItems[activeIndex] || searchItems.find(x => !x.locate);
  if (r) chooseResult(r);
});

$('#q-clear').addEventListener('click', () => {
  q.value = '';
  $('#q-clear').hidden = true;
  q.focus();
  showResults([LOCATE_ITEM]);
});

document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.topbar')) hideResults();
});

/* ---------- Kartenbewegung ---------- */

function showZoomHint(text) {
  const hint = $('#zoom-hint');
  hint.hidden = !text;
  if (text) hint.textContent = text;
}

/** Für "Jetzt geöffnet" die Öffnungszeiten der sichtbaren Stationen nachladen, sofern es nicht zu viele sind. */
async function loadVisibleHours() {
  if (!state.filters.open) return;
  const b = map.getBounds();
  const box = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  const ids = [...state.stations.values()].filter(s => matchesStatic(s) && inBBox(box, s)).map(s => s.id);
  if (ids.length > OPEN_MAP_MAX) {
    syncMarkers();
    if (!state.offline) showZoomHint('Für „Jetzt geöffnet“ hineinzoomen');
    return;
  }
  await ensureDetails(ids);
  if (state.ref && !state.selected) renderList();
}

const loadVisible = debounce(() => {
  const z = map.getZoom();
  showZoomHint(z >= MAP_LOAD_MIN_ZOOM || state.offline || z < 5 ? ''
    : state.filters.open ? 'Für „Jetzt geöffnet“ hineinzoomen' : 'Für mehr Stationen hineinzoomen');
  if (z < MAP_LOAD_MIN_ZOOM || state.offline) {
    loadVisibleHours(); // offline: Öffnungszeiten aus dem Speicher
    return;
  }
  const b = map.getBounds().pad(0.15);
  loadBox({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() })
    .then(() => { if (state.ref) { computeNearby(); if (!state.selected) renderList(); } })
    .then(loadVisibleHours)
    .catch(err => console.warn('Kartenbereich konnte nicht geladen werden', err));
}, 450);

function updateHereButton() {
  const btn = $('#here-btn');
  if (!userMovedMap || map.getZoom() < 11) { btn.hidden = true; return; }
  if (!state.ref) { btn.hidden = false; return; }
  const c = visibleCenter();
  const b = map.getBounds();
  const halfWidth = distance({ lat: c.lat, lng: b.getWest() }, { lat: c.lat, lng: b.getEast() }) / 2;
  if (state.ref.bounds) {
    // Ausschnitt-Suche: schon bei kleineren Verschiebungen oder Zoomwechsel neu anbieten
    btn.hidden = Math.abs(map.getZoom() - state.ref.zoom) < 1 && distance(c, state.ref) < halfWidth * 0.25;
  } else {
    btn.hidden = distance(c, state.ref) < Math.max(500, halfWidth * 0.6);
  }
}

map.on('dragstart', () => {
  userMovedMap = true;
  if (!isDesktop() && snap === 'half' && !state.selected) setSnap('peek');
});
map.on('movestart', () => { if (!programmaticMove) userMovedMap = true; });
map.on('moveend', () => {
  programmaticMove = false;
  const c = map.getCenter();
  local.set('view', { lat: c.lat, lng: c.lng, zoom: map.getZoom() });
  loadVisible();
  updateHereButton();
});

let lastSmall = map.getZoom() < 11;
map.on('zoomend', () => {
  const small = map.getZoom() < 11;
  if (small !== lastSmall) restyleMarkers();
  lastSmall = small;
});

$('#here-btn').addEventListener('click', () => {
  userMovedMap = false;
  const c = visibleCenter();
  setRef({
    lat: c.lat, lng: c.lng, kind: 'map', label: 'Kartenausschnitt', bounds: visibleBounds(), zoom: map.getZoom(),
  }, { fit: false });
});

/* ---------- Online/Offline ---------- */

function setOffline(offline) {
  if (state.offline === offline) return;
  state.offline = offline;
  $('#offline-badge').hidden = !offline;
}

window.addEventListener('online', () => {
  setOffline(false);
  if (state.ref) findNearby({ fit: false });
});
window.addEventListener('offline', () => {
  setOffline(true);
  renderList();
});

/* ---------- Info-Dialog, Installation, Offline-Download ---------- */

const about = $('#about');
$('#menu-btn').addEventListener('click', () => {
  hideResults();
  updateOfflineStatus();
  about.showModal();
});
about.addEventListener('click', e => { if (e.target === about) about.close(); });

let installPrompt = null;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS && !standalone) {
  $('#install-section').hidden = false;
  $('#install-text').textContent = 'Tippe in Safari auf „Teilen“ und dann auf „Zum Home-Bildschirm“.';
}
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('#install-section').hidden = false;
  $('#install-btn').hidden = false;
});
$('#install-btn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $('#install-section').hidden = true;
});
window.addEventListener('appinstalled', () => { $('#install-section').hidden = true; });

async function updateOfflineStatus() {
  const full = await store.getMeta('fullSync');
  const n = state.stations.size;
  $('#offline-status').textContent = full
    ? `${plural(n, 'Station', 'Stationen')} gespeichert (vollständig am ${new Date(full).toLocaleDateString('de-DE')})`
    : `${plural(n, 'Station', 'Stationen')} gespeichert`;
}

$('#offline-btn').addEventListener('click', async () => {
  const btn = $('#offline-btn');
  const progress = $('#offline-progress');
  const status = $('#offline-status');
  btn.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  try {
    const all = await api.fetchAll((p, n) => {
      progress.value = p;
      status.textContent = `${plural(n, 'Station', 'Stationen')} geladen …`;
    });
    const ids = new Set(all.map(s => s.id));
    mergeStations(all, [...state.stations.keys()].filter(id => !ids.has(id)));
    await store.setMeta('fullSync', Date.now());
    await updateOfflineStatus();
    if (state.ref) { computeNearby(); renderList(); }
    toast(`${plural(all.length, 'Station', 'Stationen')} für unterwegs gespeichert`);
  } catch (err) {
    console.warn(err);
    status.textContent = 'Download fehlgeschlagen. Bitte später erneut versuchen.';
  } finally {
    btn.disabled = false;
    progress.hidden = true;
  }
});

/* ---------- Service Worker ---------- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Neue Version verfügbar', { action: 'Aktualisieren', onAction: () => worker.postMessage('skipWaiting'), duration: 0 });
        }
      });
    });
  }).catch(err => console.warn('Service Worker nicht registriert', err));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
}

/* ---------- Start ---------- */

function onLayoutChange() {
  map.invalidateSize();
  setSnap(snap);
}
window.addEventListener('resize', debounce(onLayoutChange, 150));
desktopQuery.addEventListener('change', () => location.reload()); // Kontroll-Positionen hängen vom Layout ab
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  colors = readColors();
  restyleMarkers();
});

setInterval(() => {
  // Öffnungsstatus aktuell halten
  if (document.hidden) return;
  if (state.ref && !state.selected) renderList();
  if (state.filters.open) syncMarkers();
}, 60 * 1000);

async function init() {
  state.filters = { ...state.filters, ...local.get('filters', {}) };
  applyFilters();
  setSnap('half');
  $('#offline-badge').hidden = !state.offline;
  renderList();

  for (const s of await store.getAllStations()) state.stations.set(s.id, s);
  syncMarkers();

  if (location.hash) route();

  let granted = false;
  try {
    granted = (await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'granted';
  } catch { /* Permissions-API fehlt (ältere Safari-Versionen) */ }
  const params = new URLSearchParams(location.search);
  if (params.get('near') === 'me') {
    history.replaceState(null, '', location.pathname + location.hash);
    locate();
  } else if (granted || local.get('located', false)) locate({ quiet: true });
  else loadVisible();

  registerServiceWorker();
}

init();
