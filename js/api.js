// Zugriff auf die Karte-von-Morgen-API (OpenFairDB). Die Refill-Karte auf refill-deutschland.de
// ist ein Ausschnitt dieser Karte mit dem Tag "refill-station". Daten stehen unter CC0.
// API-Doku: https://github.com/kartevonmorgen/openfairdb

const API = 'https://api.ofdb.io/v0';
const TAG = 'refill-station';
export const SEARCH_LIMIT = 2000; // serverseitiges Maximum pro Anfrage

const FOUNTAIN_TAGS = new Set([
  'refill-trinkbrunnen', 'trinkbrunnen', 'trinkwasserbrunnen', 'refill-brunnen', 'eurotrinkbrunnen', 'wasserbrunnen',
]);
const ACCESSIBLE_TAGS = new Set([
  'barrierefrei', 'barrierearm', 'barrierefreiheit', 'refill-barrierefrei-leitungswasser', 'refill-station-barrierefrei',
]);

const round = n => Math.round(n * 1e6) / 1e6;

/** Kompakte Form für Liste, Karte und IndexedDB. */
function toStation(e) {
  const tags = e.tags || [];
  return {
    id: e.id,
    lat: e.lat,
    lng: e.lng,
    title: (e.title || 'Refill-Station').trim(),
    fountain: tags.some(t => FOUNTAIN_TAGS.has(t)),
    accessible: tags.some(t => ACCESSIBLE_TAGS.has(t)),
  };
}

function toDetails(e) {
  return {
    id: e.id,
    lat: e.lat,
    lng: e.lng,
    title: (e.title || '').trim(),
    description: (e.description || '').trim(),
    street: e.street || '',
    zip: e.zip || '',
    city: e.city || '',
    country: e.country || '',
    phone: e.telephone || '',
    email: e.email || '',
    homepage: e.homepage || '',
    openingHours: (e.opening_hours || '').trim(),
    imageUrl: e.image_url || '',
    tags: e.tags || [],
    fetched: Date.now(),
  };
}

/** Kompakte Station aus Detaildaten, z. B. für Deep-Links auf noch nicht geladene Stationen. */
export const stationFromDetails = toStation;

async function getJSON(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Alle Refill-Stationen in einer Bounding-Box.
 * @returns {Promise<{stations: object[], truncated: boolean}>}
 */
export async function searchBBox(b, { signal } = {}) {
  const bbox = [b.south, b.west, b.north, b.east].map(round).join(',');
  const data = await getJSON(`${API}/search?bbox=${bbox}&tags=${TAG}&limit=${SEARCH_LIMIT}`, signal);
  const visible = data.visible || [];
  return { stations: visible.map(toStation), truncated: visible.length >= SEARCH_LIMIT };
}

/** Details (Adresse, Öffnungszeiten, Kontakt) für bis zu 50 IDs. */
export async function fetchDetails(ids, { signal } = {}) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await getJSON(`${API}/entries/${chunk.join(',')}`, signal);
    out.push(...data.map(toDetails));
  }
  return out;
}

/** Ortssuche über Photon (OSM-basiert, CORS-fähig). */
export async function geocode(query, near, { signal } = {}) {
  const params = new URLSearchParams({ q: query, lang: 'de', limit: '6' });
  if (near) {
    params.set('lat', near.lat.toFixed(4));
    params.set('lon', near.lng.toFixed(4));
  }
  const data = await getJSON(`https://photon.komoot.io/api/?${params}`, signal);
  return (data.features || []).map(f => {
    const p = f.properties || {};
    const [lng, lat] = f.geometry.coordinates;
    const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || query;
    const context = [p.postcode, p.city !== name ? p.city : null, p.state, p.country !== 'Deutschland' ? p.country : null]
      .filter(Boolean).join(', ');
    return { lat, lng, name, context, extent: p.extent || null };
  });
}

/** Lädt alle Stationen im Verbreitungsgebiet (Kacheln, bei Überlauf weiter unterteilt). */
export async function fetchAll(onProgress, { signal } = {}) {
  const queue = [];
  for (let lat = 44; lat < 58; lat += 2) {
    for (let lng = 2; lng < 20; lng += 2) queue.push({ south: lat, west: lng, north: lat + 2, east: lng + 2 });
  }
  const total = queue.length;
  let done = 0;
  const all = new Map();
  while (queue.length) {
    const box = queue.shift();
    const { stations, truncated } = await searchBBox(box, { signal });
    if (truncated) {
      const midLat = (box.south + box.north) / 2, midLng = (box.west + box.east) / 2;
      queue.push(
        { south: box.south, west: box.west, north: midLat, east: midLng },
        { south: box.south, west: midLng, north: midLat, east: box.east },
        { south: midLat, west: box.west, north: box.north, east: midLng },
        { south: midLat, west: midLng, north: box.north, east: box.east },
      );
    } else {
      for (const s of stations) all.set(s.id, s);
      done++;
    }
    onProgress?.(done / (done + queue.length || total), all.size);
  }
  return [...all.values()];
}

export function kvmUrl(id) {
  return `https://www.kartevonmorgen.org/m/refill?entry=${encodeURIComponent(id)}`;
}
