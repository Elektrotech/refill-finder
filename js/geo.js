const R = 6371008.8;
const rad = d => d * Math.PI / 180;

/** Luftlinie in Metern. */
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Quadratische Bounding-Box, die einen Kreis mit `radius` Metern um `p` umschließt. */
export function bboxAround(p, radius) {
  const dLat = radius / 111320;
  const dLng = radius / (111320 * Math.max(0.01, Math.cos(rad(p.lat))));
  return { south: p.lat - dLat, west: p.lng - dLng, north: p.lat + dLat, east: p.lng + dLng };
}

export function bboxContains(outer, inner) {
  return inner.south >= outer.south && inner.north <= outer.north && inner.west >= outer.west && inner.east <= outer.east;
}

export function inBBox(b, p) {
  return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
}

const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

export function formatDistance(m) {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  if (m < 9950) return `${nf1.format(m / 1000)} km`;
  return `${Math.round(m / 1000)} km`;
}

/** Gehzeit bei ca. 4,8 km/h, Luftlinie × 1,25 als grobe Wegstrecke. */
export function formatWalk(m) {
  const min = Math.max(1, Math.round((m * 1.25) / 80));
  if (min > 90) return null;
  return `${min} Min.`;
}
