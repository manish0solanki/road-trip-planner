// All network calls. Every service here is free and needs no API key.
//  - Photon (komoot)         place search / autocomplete
//  - Nominatim (OSM)         reverse geocoding fallback
//  - OSRM public servers     driving route
//  - Photon nearby search    towns, stays, fuel, dhabas, sights (OSM data)
//  - Open-Meteo              forecast + last-year weather, sunrise/sunset
//  - Wikipedia               things to do near a place
import { getJSON, cumulative } from './util.js';

const PHOTON = 'https://photon.komoot.io';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OSRM = ['https://router.project-osrm.org', 'https://routing.openstreetmap.de/routed-car'];

// ---------------- places ----------------
function photonLabel(p) {
  const main = p.name || p.street || p.city || '';
  const parts = [p.city !== main ? p.city : null, p.state, p.country].filter(Boolean);
  // drop duplicates like "Manali, Manali"
  return { name: main, detail: [...new Set(parts)].filter((x) => x !== main).join(', ') };
}

export async function searchPlaces(q, signal) {
  const url = `${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6&lang=en&lat=22.5&lon=79&location_bias_scale=0.3`;
  const data = await getJSON(url, { signal, persist: true });
  const seen = new Set();
  return (data.features || []).map((f) => {
    const p = f.properties || {};
    const { name, detail } = photonLabel(p);
    return { name, detail, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], kind: p.osm_value || p.type };
  }).filter((r) => r.name && !seen.has(r.name + r.detail) && seen.add(r.name + r.detail));
}

export async function geocode(q) {
  const r = await searchPlaces(q);
  if (!r.length) throw new Error(`Couldn't find “${q}”. Try adding the state, e.g. “${q}, Himachal Pradesh”.`);
  return r[0];
}

export async function reverse(lat, lon) {
  try {
    const d = await getJSON(`${PHOTON}/reverse?lat=${lat}&lon=${lon}&lang=en`, { persist: true });
    const p = d.features?.[0]?.properties;
    if (p) {
      const name = p.city || p.town || p.village || p.county || p.name;
      if (name) return { name, detail: [p.state, p.country].filter(Boolean).join(', ') };
    }
  } catch { /* fall through */ }
  const d = await getJSON(`${NOMINATIM}/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`, { persist: true, minGap: 1100 });
  const a = d.address || {};
  return { name: a.city || a.town || a.village || a.county || a.state_district || d.name || 'Nearby town', detail: [a.state, a.country].filter(Boolean).join(', ') };
}

// ---------------- route ----------------
export async function route(points) {
  const coords = points.map((p) => `${(+p.lon).toFixed(5)},${(+p.lat).toFixed(5)}`).join(';');
  let lastErr;
  for (const base of OSRM) {
    try {
      const d = await getJSON(`${base}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false&alternatives=false`, { timeout: 25000 });
      if (d.code !== 'Ok' || !d.routes?.length) throw new Error(d.message || 'No road route found between these places.');
      const r = d.routes[0];
      return {
        distance: r.distance,
        duration: r.duration,
        legs: r.legs.map((l) => ({ distance: l.distance, duration: l.duration })),
        coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
      };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Routing service is busy or no road connects these places (${lastErr?.message || 'unknown error'}). Please try again in a minute.`);
}

// ---------------- nearby places (Photon + Wikipedia) ----------------
// Photon's nearby search answers in well under a second, unlike the public Overpass
// servers which often time out. We sample points along the route and ask Photon
// (and Wikipedia for sights) what's around each one.

// Run async tasks with limited concurrency; returns settled results.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = { ok: true, v: await fn(items[k], k) }; } catch (e) { out[k] = { ok: false, e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
// If most lookups failed, surface an error so the UI shows a Retry button.
function okValues(results, what) {
  const ok = results.filter((r) => r.ok);
  if (results.length && ok.length < Math.ceil(results.length / 2)) throw new Error(`${what} didn't load: ${results.find((r) => !r.ok)?.e?.message || 'service busy'}`);
  return ok.flatMap((r) => r.v);
}

async function nearby(lat, lon, { radiusKm, limit = 50, tags }) {
  const url = `${PHOTON}/reverse?lat=${(+lat).toFixed(5)}&lon=${(+lon).toFixed(5)}&radius=${radiusKm}&limit=${limit}&lang=en&`
    + tags.map((t) => 'osm_tag=' + encodeURIComponent(t)).join('&');
  const d = await getJSON(url, { persist: true, timeout: 15000 });
  return (d.features || []).map((f) => {
    const p = f.properties || {};
    return {
      id: `${p.osm_type || 'X'}/${p.osm_id}`, name: p.name || '', key: p.osm_key, value: p.osm_value,
      lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
      street: p.street || '', locality: p.locality || p.district || '', city: p.city || p.town || p.village || p.county || '', state: p.state || '',
    };
  });
}

// Points every `stepKm` along a path ([lat, lon][]), always including the end.
function samplePath(coords, stepKm, max) {
  const cum = cumulative(coords), total = cum[cum.length - 1];
  const step = Math.max(stepKm * 1000, total / max);
  const pts = [];
  for (let d = step / 2, i = 0; d < total; d += step) { while (i < cum.length - 1 && cum[i] < d) i++; pts.push(coords[i]); }
  if (!pts.length) pts.push(coords[Math.floor(coords.length / 2)]);
  return pts;
}

const dedupe = (list) => { const seen = new Set(); return list.filter((x) => !seen.has(x.id) && seen.add(x.id)); };

export async function townsNear(points, radiusKm = 30) {
  const res = await pool(points, 3, ([lat, lon]) => nearby(lat, lon, { radiusKm, limit: 30, tags: ['place:city', 'place:town'] }));
  return dedupe(okValues(res, 'Towns')).filter((t) => t.name).map((t) => ({ name: t.name, lat: t.lat, lon: t.lon, place: t.value, population: 0 }));
}

const SIGHT_TAGS = ['tourism:attraction', 'tourism:viewpoint', 'tourism:museum', 'tourism:zoo', 'tourism:theme_park', 'historic:fort', 'historic:castle',
  'historic:monument', 'historic:palace', 'historic:ruins', 'historic:archaeological_site', 'natural:waterfall', 'natural:beach', 'natural:hot_spring'];
const BORING = /^(city|town|village|census town|municipality|tehsil|taluk|suburb|area|neighbourhood|neighborhood|locality|human settlement|place in|district|railway station|bus station|school|college|university|hospital|airport|river|road|highway|national highway|constituency|lok sabha|vidhan sabha|state highway|mountain pass in)\b/i;

// Sights, fuel and dhabas along one day's path.
export async function poisAlong(coords) {
  const fuelPts = samplePath(coords, 25, 20);  // stations: a lookup every ~25 km
  const sightPts = samplePath(coords, 50, 6);  // sparser for sights
  const [fuelRes, sightRes, wikiRes] = await Promise.all([
    pool(fuelPts, 3, ([a, b]) => nearby(a, b, { radiusKm: 4, limit: 25, tags: ['amenity:fuel', 'amenity:restaurant', 'amenity:fast_food'] })),
    pool(sightPts, 2, ([a, b]) => nearby(a, b, { radiusKm: 8, limit: 15, tags: SIGHT_TAGS })),
    pool(sightPts.filter((_, i) => i % 2 === 0), 2, ([a, b]) => wikiNear(a, b, 10000, 8)),
  ]);
  const places = dedupe(okValues(fuelRes, 'Fuel stops'));
  const fuel = places.filter((p) => p.value === 'fuel').map((p) => ({ ...p, name: p.name || 'Fuel station', tags: { amenity: 'fuel' } }));
  const foodNames = new Set();
  const food = places.filter((p) => p.value !== 'fuel' && /dhaba|food plaza|food court|haveli|highway/i.test(p.name))
    .filter((p) => !foodNames.has(p.name.toLowerCase()) && foodNames.add(p.name.toLowerCase()))
    .map((p) => ({ ...p, tags: { amenity: p.value } }));
  const osmSights = dedupe(sightRes.filter((r) => r.ok).flatMap((r) => r.v)).filter((s) => s.name).map((s) => ({ ...s, tags: { [s.key]: s.value } }));
  const wiki = wikiRes.filter((r) => r.ok).flatMap((r) => r.v)
    .filter((w) => w.lat != null && !BORING.test(w.description || ''))
    .map((w) => ({ id: 'wiki/' + w.title, name: w.title, lat: w.lat, lon: w.lon, tags: { wikipedia: 'en:' + w.title, tourism: 'attraction' }, description: w.description, thumb: w.thumb }));
  // Wikipedia-backed places first (they're notable), then OSM sights not already covered
  const names = new Set(wiki.map((w) => w.name.toLowerCase()));
  // drop near-duplicates like "X Waterfall Base" / "X Waterfall Upper View" and signboards
  const stem = (n) => n.toLowerCase().replace(/\(.*?\)/g, '').split(/\s+/).slice(0, 2).join(' ');
  const stems = new Set();
  const sights = dedupe([...wiki, ...osmSights.filter((s) => !names.has(s.name.toLowerCase()))])
    .filter((s) => !/^i love\b|selfie point|^entry|^exit|parking/i.test(s.name))
    .filter((s) => !stems.has(stem(s.name)) && stems.add(stem(s.name)));
  return { sights, fuel, food };
}

const STAY_TAGS = ['tourism:hotel', 'tourism:guest_house', 'tourism:hostel', 'tourism:motel', 'tourism:camp_site', 'tourism:apartment', 'tourism:chalet', 'tourism:alpine_hut', 'leisure:resort'];
export async function staysNear(halts, radiusKm = 7) {
  // small towns may have nothing listed close by: widen the search when results are thin
  const res = await pool(halts, 2, async (p) => {
    const r = await nearby(p.lat, p.lon, { radiusKm, limit: 50, tags: STAY_TAGS });
    return r.filter((x) => x.name).length >= 6 ? r : nearby(p.lat, p.lon, { radiusKm: 25, limit: 50, tags: STAY_TAGS });
  });
  return dedupe(okValues(res, 'Stays')).filter((s) => s.name).map((s) => ({
    id: s.id, name: s.name, lat: s.lat, lon: s.lon,
    type: s.key === 'leisure' ? 'resort' : s.value,
    stars: 0, phone: '', website: '', rooms: 0,
    area: [s.street, s.locality || s.city].filter(Boolean).join(', '),
    tags: { [s.key]: s.value },
  }));
}

// ---------------- weather ----------------
const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum';

function shiftYear(iso, n) { const [y, m, d] = iso.split('-'); return `${+y + n}-${m}-${d === '29' && m === '02' ? '28' : d}`; }

// requests: [{lat, lon, date: 'YYYY-MM-DD'}] -> results aligned by index
export async function weatherFor(requests) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const horizon = new Date(today); horizon.setDate(horizon.getDate() + 15);
  const fc = [], ar = [];
  requests.forEach((r, i) => {
    const d = new Date(r.date + 'T00:00:00');
    (d >= today && d <= horizon ? fc : ar).push({ ...r, i });
  });
  const out = new Array(requests.length).fill(null);
  const group = (list) => {
    const m = new Map();
    list.forEach((r) => { const k = `${r.lat.toFixed(2)},${r.lon.toFixed(2)}`; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
    return [...m.values()];
  };
  const pick = (res, r, dateKey, source) => {
    const idx = res.daily?.time?.indexOf(dateKey);
    if (idx == null || idx < 0) return;
    const D = res.daily;
    out[r.i] = {
      source,
      code: D.weather_code[idx], max: D.temperature_2m_max[idx], min: D.temperature_2m_min[idx],
      // last-year data carries last year's date: keep the clock time, use the trip's date
      sunrise: String(D.sunrise[idx]).replace(/^\d{4}-\d\d-\d\d/, r.date), sunset: String(D.sunset[idx]).replace(/^\d{4}-\d\d-\d\d/, r.date), rain: D.precipitation_sum?.[idx] ?? 0,
      rainProb: D.precipitation_probability_max?.[idx] ?? null, elevation: res.elevation,
    };
  };
  const jobs = [];
  if (fc.length) {
    const groups = group(fc);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${groups.map((g) => g[0].lat.toFixed(3)).join(',')}&longitude=${groups.map((g) => g[0].lon.toFixed(3)).join(',')}&daily=${DAILY},precipitation_probability_max&timezone=auto&forecast_days=16`;
    jobs.push(getJSON(url).then((d) => { const arr = Array.isArray(d) ? d : [d]; groups.forEach((g, gi) => g.forEach((r) => pick(arr[gi], r, r.date, 'forecast'))); }));
  }
  if (ar.length) {
    const groups = group(ar);
    const dates = ar.map((r) => shiftYear(r.date, -1)).sort();
    // archive can't reach the most recent days; if trip is in the near past, go two years back
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${groups.map((g) => g[0].lat.toFixed(3)).join(',')}&longitude=${groups.map((g) => g[0].lon.toFixed(3)).join(',')}&start_date=${dates[0]}&end_date=${dates[dates.length - 1]}&daily=${DAILY}&timezone=auto`;
    jobs.push(getJSON(url, { persist: true }).then((d) => { const arr = Array.isArray(d) ? d : [d]; groups.forEach((g, gi) => g.forEach((r) => pick(arr[gi], r, shiftYear(r.date, -1), 'last-year'))); }));
  }
  await Promise.allSettled(jobs);
  return out;
}

// ---------------- Wikipedia ----------------
export async function wikiNear(lat, lon, radius = 10000, limit = 10) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=geosearch&ggscoord=${lat}|${lon}&ggsradius=${radius}&ggslimit=${limit}&prop=pageimages|description|coordinates&piprop=thumbnail&pithumbsize=160&pilimit=${limit}`;
  const d = await getJSON(url, { persist: true });
  const pages = Object.values(d.query?.pages || {});
  return pages
    .filter((p) => !/district|tehsil|constituency|railway station|airport|school|college|university|village in|list of/i.test((p.description || '') + ' ' + p.title))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => ({
      title: p.title, description: p.description || '', thumb: p.thumbnail?.source || '',
      lat: p.coordinates?.[0]?.lat, lon: p.coordinates?.[0]?.lon,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
    }));
}
