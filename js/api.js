// All network calls. Every service here is free and needs no API key.
//  - Photon (komoot)         place search / autocomplete
//  - Nominatim (OSM)         reverse geocoding fallback
//  - OSRM public servers     driving route
//  - Overpass API (OSM)      towns, sights, fuel, dhabas, stays
//  - Open-Meteo              forecast + last-year weather, sunrise/sunset
//  - Wikipedia               things to do near a place
import { getJSON, simplifyTo } from './util.js';

const PHOTON = 'https://photon.komoot.io';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OSRM = ['https://router.project-osrm.org', 'https://routing.openstreetmap.de/routed-car'];
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

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

// ---------------- Overpass ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    // the public servers answer 429/503/504 when busy: wait and try once more before moving on
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await getJSON(url, { body: 'data=' + encodeURIComponent(query), minGap: 1000, timeout: 70000 });
      } catch (e) {
        lastErr = e;
        if (!/ (429|503|504)$/.test(e.message) || attempt) break;
        await sleep(4000);
      }
    }
  }
  throw lastErr;
}

const around = (r, pts) => `around:${r},${pts.map(([a, b]) => `${a.toFixed(4)},${b.toFixed(4)}`).join(',')}`;
const centerOf = (el) => (el.lat != null ? [el.lat, el.lon] : el.center ? [el.center.lat, el.center.lon] : null);

export async function townsNear(points, radius = 35000) {
  const q = `[out:json][timeout:40];(${points.map(([a, b]) => `node[place~"^(city|town)$"][name](around:${radius},${a.toFixed(4)},${b.toFixed(4)});`).join('')});out tags 600;`;
  const d = await overpass(q);
  return (d.elements || []).map((e) => ({
    name: e.tags['name:en'] || e.tags.name,
    lat: e.lat, lon: e.lon,
    place: e.tags.place,
    population: parseInt(String(e.tags.population || '0').replace(/\D/g, ''), 10) || 0,
  }));
}

// Sights, fuel and dhabas along one day's path.
export async function poisAlong(coords) {
  const pts = simplifyTo(coords, 45);
  const near = around(2500, pts), close = around(1200, pts);
  const q = `[out:json][timeout:60];
(
  nwr[tourism~"^(attraction|viewpoint|museum|zoo|theme_park|gallery)$"][name](${near});
  nwr[historic~"^(fort|castle|monument|palace|ruins|archaeological_site|memorial)$"][name][wikidata](${near});
  nwr[natural~"^(waterfall|beach|cave_entrance|hot_spring)$"][name](${near});
  nwr[amenity=place_of_worship][name][wikidata](${close});
);
out center tags 60;
node[amenity=fuel](${close});
out tags 300;
nwr[amenity~"^(restaurant|fast_food|food_court)$"][name~"dhaba|food plaza|food court|haveli",i](${close});
out center tags 40;`;
  const d = await overpass(q);
  const sights = [], fuel = [], food = [];
  for (const e of d.elements || []) {
    const t = e.tags || {}, c = centerOf(e);
    if (!c) continue;
    const item = { id: `${e.type}/${e.id}`, name: t['name:en'] || t.name, lat: c[0], lon: c[1], tags: t };
    if (t.amenity === 'fuel') fuel.push({ ...item, name: item.name || t.brand || t.operator || 'Fuel station' });
    else if (/restaurant|fast_food|food_court/.test(t.amenity || '')) item.name && food.push(item);
    else if (item.name) sights.push(item);
  }
  const score = (s) => (s.tags.wikipedia ? 3 : 0) + (s.tags.wikidata ? 2 : 0) + (s.tags.tourism === 'attraction' || s.tags.tourism === 'viewpoint' ? 1 : 0) + (s.tags.natural ? 1 : 0);
  sights.sort((a, b) => score(b) - score(a));
  return { sights, fuel, food };
}

const STAY_TYPES = 'hotel|guest_house|hostel|motel|camp_site|apartment|chalet|alpine_hut|resort';
export async function staysNear(halts, radius = 7000) {
  const q = `[out:json][timeout:60];(${halts.map((p) =>
    `nwr[tourism~"^(${STAY_TYPES})$"][name](around:${radius},${p.lat.toFixed(4)},${p.lon.toFixed(4)});nwr[leisure=resort][name](around:${radius},${p.lat.toFixed(4)},${p.lon.toFixed(4)});`).join('')});out center tags 500;`;
  const d = await overpass(q);
  return (d.elements || []).map((e) => {
    const t = e.tags || {}, c = centerOf(e);
    return c && {
      id: `${e.type}/${e.id}`, name: t['name:en'] || t.name, lat: c[0], lon: c[1],
      type: t.leisure === 'resort' ? 'resort' : t.tourism,
      stars: parseFloat(t.stars) || 0,
      phone: t.phone || t['contact:phone'] || t['contact:mobile'] || '',
      website: t.website || t['contact:website'] || t.url || '',
      area: t['addr:suburb'] || t['addr:street'] || t['addr:city'] || t['addr:place'] || '',
      rooms: parseInt(t.rooms, 10) || 0,
      tags: t,
    };
  }).filter(Boolean);
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
      sunrise: D.sunrise[idx], sunset: D.sunset[idx], rain: D.precipitation_sum?.[idx] ?? 0,
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
