// Real geocoding for Kathmandu, proxied through our server so the client CSP
// stays locked to 'self' and we control caching + politeness.
//
// Provider: OpenStreetMap Nominatim (free, no key). Their usage policy requires
// a real User-Agent, max 1 request/second, and caching — all enforced here.
// For serious volume, swap NOMINATIM_BASE for a paid host (LocationIQ, Geoapify
// etc. speak the same API) via the env var without touching any other code.
const { config } = require('./config');
const { PLACES } = require('./places');

const NOMINATIM_BASE = process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org';
// Road routing (driver navigation + route lines on maps): OSRM speaks a
// simple open API. The public demo server is fine for a pilot; point
// OSRM_BASE at a paid host (Mapbox/OpenRouteService proxy or self-hosted
// OSRM) for production volume.
const OSRM_BASE = process.env.OSRM_BASE || 'https://router.project-osrm.org';
const USER_AGENT = `SewaGo/0.1 (${config.publicAppUrl || 'https://sewago.example'})`;

// Kathmandu valley bounding box — search is biased hard to it so "New Road"
// resolves to Kathmandu's, not some other city's.
const VALLEY = { west: 85.15, south: 27.55, east: 85.55, north: 27.82 };

function insideServiceArea(lat, lng) {
  // SERVICE_AREA=global (the dev default) accepts coordinates anywhere, so the
  // whole ride/delivery flow can be tested with real GPS outside Nepal.
  if (config.serviceArea !== 'kathmandu') return true;
  return lat >= VALLEY.south && lat <= VALLEY.north && lng >= VALLEY.west && lng <= VALLEY.east;
}

// A location is either real GPS/geocoded coords ({lat,lng,name}) or free text
// that the built-in gazetteer resolves. Real coords must be inside the valley.
// Shared by ride endpoints and food-delivery addresses.
function resolveLocation(input) {
  if (input && typeof input === 'object' && Number.isFinite(Number(input.lat)) && Number.isFinite(Number(input.lng))) {
    const lat = Math.round(Number(input.lat) * 1e6) / 1e6;
    const lng = Math.round(Number(input.lng) * 1e6) / 1e6;
    if (!insideServiceArea(lat, lng)) return { error: 'outside' };
    const name = String(input.name || '').trim().slice(0, 80) || 'Pinned location';
    return { name, lat, lng, known: true };
  }
  if (typeof input === 'string' && input.trim()) {
    const { coordsFor } = require('./places');
    return coordsFor(input);
  }
  return { error: 'missing' };
}

// --- tiny cache + politeness queue ------------------------------------------
const cache = new Map(); // key -> { value, expiresAt }
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 2000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    // drop the oldest ~10% (Map preserves insertion order)
    let n = Math.ceil(CACHE_MAX / 10);
    for (const k of cache.keys()) {
      cache.delete(k);
      if (--n <= 0) break;
    }
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Nominatim allows 1 req/s: serialize outbound calls with a minimum gap.
let lastCallAt = 0;
let chain = Promise.resolve();
function politeFetch(url) {
  const run = async () => {
    const wait = Math.max(0, lastCallAt + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error(`Geocoder responded ${res.status}`);
    return res.json();
  };
  chain = chain.catch(() => {}).then(run);
  return chain;
}

// Compact "Thamel Marg, Kathmandu" style label from a Nominatim result.
function shortLabel(item) {
  const a = item.address || {};
  const main = a.amenity || a.shop || a.tourism || a.building || a.road || a.neighbourhood ||
    a.suburb || a.village || a.town || (item.display_name || '').split(',')[0];
  const area = a.suburb || a.neighbourhood || a.city_district || a.municipality || a.city || a.town || '';
  const label = area && area !== main ? `${main}, ${area}` : String(main || '').trim();
  return label || (item.display_name || '').split(',').slice(0, 2).join(',');
}

// Curated Kathmandu landmarks that match the query, best match first. These are
// hand-verified coordinates, so for common searches ("thamel", "patan") they beat
// whatever administrative boundary OSM would rank first — and cost no API call.
function gazetteerMatches(q) {
  const lc = q.toLowerCase();
  return PLACES
    .map((p) => {
      const name = p.name.toLowerCase();
      let score = -1;
      if (name === lc) score = 3;
      else if (name.startsWith(lc)) score = 2;
      else if (name.includes(lc)) score = 1;
      else if (lc.length >= 4 && lc.includes(name)) score = 0; // "patan durbar" -> Patan…
      return score >= 0 ? { name: p.name, lat: p.lat, lng: p.lng, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

// A bare landmark word ("patan") should surface the place, not a district
// boundary. Demote administrative/boundary hits so real POIs and roads win.
function osmRank(r) {
  const category = r.category || r.class || '';
  const type = r.type || '';
  const addresstype = r.addresstype || '';
  const isAdmin = category === 'boundary' || type === 'administrative' || addresstype === 'administrative';
  const importance = Number(r.importance) || 0;
  return { isAdmin, importance };
}

async function searchPlaces(query) {
  const q = String(query || '').trim().slice(0, 80);
  if (q.length < 2) return [];
  const key = `s:${q.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '8'
  });
  // Kathmandu mode pins search to the valley; global mode searches the world
  // so testers outside Nepal can find their own streets.
  if (config.serviceArea === 'kathmandu') {
    params.set('countrycodes', 'np');
    params.set('viewbox', `${VALLEY.west},${VALLEY.north},${VALLEY.east},${VALLEY.south}`);
    params.set('bounded', '1');
  }
  const rows = await politeFetch(`${NOMINATIM_BASE}/search?${params}`);
  // POIs/roads before administrative boundaries; ties broken by OSM importance.
  const osm = (Array.isArray(rows) ? rows : [])
    .map((r) => ({ r, rank: osmRank(r) }))
    .sort((a, b) => (Number(a.rank.isAdmin) - Number(b.rank.isAdmin)) || (b.rank.importance - a.rank.importance))
    .map(({ r }) => ({
      name: shortLabel(r),
      lat: Math.round(Number(r.lat) * 1e6) / 1e6,
      lng: Math.round(Number(r.lon) * 1e6) / 1e6
    }));

  const seen = new Set();
  const results = [];
  // Curated landmarks first, then OSM fills the long tail.
  for (const item of [...gazetteerMatches(q), ...osm]) {
    const lat = Math.round(Number(item.lat) * 1e6) / 1e6;
    const lng = Math.round(Number(item.lng) * 1e6) / 1e6;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // Collapse duplicates: same label, or a pin within ~100m of one we kept.
    const nameKey = item.name.toLowerCase();
    const coordKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (seen.has(nameKey) || seen.has(coordKey)) continue;
    seen.add(nameKey);
    seen.add(coordKey);
    results.push({ name: item.name, lat, lng });
    if (results.length >= 6) break;
  }
  cacheSet(key, results);
  return results;
}

async function reverseGeocode(lat, lng) {
  // round to ~11m so nearby requests share a cache entry
  const rlat = Math.round(lat * 1e4) / 1e4;
  const rlng = Math.round(lng * 1e4) / 1e4;
  const key = `r:${rlat},${rlng}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    lat: String(rlat),
    lon: String(rlng),
    format: 'jsonv2',
    addressdetails: '1',
    zoom: '17'
  });
  const row = await politeFetch(`${NOMINATIM_BASE}/reverse?${params}`);
  const result = {
    name: row && row.display_name ? shortLabel(row) : 'Pinned location',
    lat: rlat,
    lng: rlng
  };
  cacheSet(key, result);
  return result;
}

// Driving route between two points: the polyline to draw plus distance/time.
// Cached at ~11m origin granularity so a navigating driver re-requesting
// every ~25s doesn't hammer the router, and identical trips share an entry.
async function routeBetween(from, to) {
  const key = `rt:${from.lat.toFixed(4)},${from.lng.toFixed(4)};${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `${OSRM_BASE}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}` +
    '?overview=full&geometries=geojson&alternatives=false&steps=false';
  const data = await politeFetch(url);
  const route = data && data.code === 'Ok' && Array.isArray(data.routes) && data.routes[0];
  if (!route || !route.geometry || !Array.isArray(route.geometry.coordinates)) {
    throw new Error('No route found');
  }
  const result = {
    // GeoJSON is [lng,lat]; Leaflet wants [lat,lng].
    points: route.geometry.coordinates.map(([lng, lat]) => [
      Math.round(lat * 1e5) / 1e5,
      Math.round(lng * 1e5) / 1e5
    ]),
    distanceKm: Math.round(route.distance / 100) / 10,
    durationMin: Math.max(1, Math.round(route.duration / 60))
  };
  cacheSet(key, result);
  return result;
}

module.exports = { searchPlaces, reverseGeocode, insideServiceArea, resolveLocation, routeBetween, VALLEY };
