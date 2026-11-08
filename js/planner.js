// Pure planning logic (no DOM, no network): day splitting, costs, packing, bingo.
import { cumulative, haversine, parseDate, addDays, isoDate, shuffle } from './util.js';

export const VEHICLES = {
  hatchback: { label: 'Hatchback', icon: '🚗', seats: 4, mileage: 18, toll: true, speed: 1 },
  sedan: { label: 'Sedan', icon: '🚘', seats: 4, mileage: 16, toll: true, speed: 1 },
  suv: { label: 'SUV', icon: '🚙', seats: 5, mileage: 13, toll: true, speed: 1 },
  seven: { label: '7-seater', icon: '🚐', seats: 7, mileage: 12, toll: true, speed: 1.03 },
  bike: { label: 'Bike', icon: '🏍️', seats: 2, mileage: 40, toll: false, speed: 1.12 },
};

export const PACE = {
  relaxed: { label: 'Relaxed', icon: '🐢', breakEvery: 1.5, breakMin: 25 },
  balanced: { label: 'Balanced', icon: '⚖️', breakEvery: 2, breakMin: 20 },
  push: { label: 'Push hard', icon: '⚡', breakEvery: 3, breakMin: 15 },
};

export const BUDGET = {
  budget: { label: 'Budget', icon: '🏕️', room: 1200, food: 450 },
  comfort: { label: 'Comfort', icon: '🏨', room: 2500, food: 750 },
  premium: { label: 'Premium', icon: '✨', room: 5500, food: 1500 },
};

// Public routing engines assume free-flowing traffic; Indian highways, ghats and
// town crossings are slower. This buffer makes the drive times realistic.
export const ROAD_BUFFER = 1.2;
export const LOCAL_KM_PER_REST_DAY = 30;
export const TOLL_PER_KM = 1.0;

export function defaultTitle(places, start, roundTrip) {
  const a = short(places[0].name), b = short(places[places.length - 1].name);
  const m = start.getMonth();
  const vibe = m === 11 || m <= 1 ? 'Winter Escape' : m <= 4 ? 'Summer Run' : m <= 8 ? 'Monsoon Drive' : 'Autumn Getaway';
  return `${a} → ${b} ${roundTrip ? vibe : 'Road Trip'}`;
}
export const short = (n) => String(n || '').split(',')[0].trim();

// ---------------- timeline ----------------
// Attach time (s) to every geometry point using each leg's own average speed.
export function buildTimeline(route, waypoints, factor) {
  const coords = route.coords;
  const dist = cumulative(coords);
  // Locate each waypoint on the geometry using the legs' own distances (robust for
  // round trips, where the return path passes the same places again).
  const total = dist[dist.length - 1] || 1;
  const scale = total / (route.legs.reduce((s, l) => s + l.distance, 0) || total);
  const wpIdx = [0];
  let acc = 0, i = 0;
  for (let w = 1; w < waypoints.length; w++) {
    acc += (route.legs[w - 1]?.distance || 0) * scale;
    if (w === waypoints.length - 1) { wpIdx.push(coords.length - 1); break; }
    while (i < coords.length - 1 && dist[i] < acc) i++;
    // refine: nearest point to the waypoint within ±3 km of the estimate
    const target = [waypoints[w].lat, waypoints[w].lon];
    let best = i, bd = Infinity;
    for (let j = i; j >= 0 && dist[i] - dist[j] < 3000; j--) { const d = haversine(coords[j], target); if (d < bd) { bd = d; best = j; } }
    for (let j = i; j < coords.length && dist[j] - dist[i] < 3000; j++) { const d = haversine(coords[j], target); if (d < bd) { bd = d; best = j; } }
    best = Math.max(best, wpIdx[wpIdx.length - 1]);
    wpIdx.push(best);
    i = best;
  }
  const time = new Array(coords.length).fill(0);
  for (let l = 0; l < wpIdx.length - 1; l++) {
    const a = wpIdx[l], b = wpIdx[l + 1];
    const gd = dist[b] - dist[a] || 1;
    const legDur = (route.legs[l]?.duration || 0) * factor;
    for (let i = a + 1; i <= b; i++) time[i] = time[a] + ((dist[i] - dist[a]) / gd) * legDur;
  }
  return { coords, dist, time, wpIdx };
}

// ---------------- day allocation ----------------
// Returns skeleton days with split *targets* (geometry index ranges are fixed after town snapping).
export function allocate({ timeline, waypoints, roundTrip, destIndex, nDays, maxHours, pace }) {
  const { time, wpIdx } = timeline;
  const endI = time.length - 1;
  let journeys;
  const destGeo = wpIdx[destIndex];
  if (roundTrip && nDays >= 2 && destGeo > 0 && destGeo < endI) journeys = [[0, destGeo], [destGeo, endI]];
  else journeys = [[0, endI]];

  const maxS = maxHours * 3600;
  const hrs = journeys.map(([a, b]) => time[b] - time[a]);
  let k = hrs.map((s) => Math.max(1, Math.ceil(s / maxS - 0.05)));
  const warnings = [];

  const minDays = k.reduce((a, b) => a + b, 0);
  if (minDays > nDays) {
    warnings.push(`At ${maxHours} h a day this route needs ${minDays} driving days, but your trip is ${nDays} day${nDays > 1 ? 's' : ''}. Some days go over your limit — add days or raise the limit.`);
    // shrink: take from the journey with the shortest per-day load
    while (k.reduce((a, b) => a + b, 0) > nDays) {
      let best = -1, bestLoad = Infinity;
      k.forEach((kk, j) => { if (kk > 1 && hrs[j] / (kk - 1) < bestLoad) { bestLoad = hrs[j] / (kk - 1); best = j; } });
      if (best < 0) break;
      k[best]--;
    }
  }
  let rest = nDays - k.reduce((a, b) => a + b, 0);

  // Relaxed pace: spend spare days to shorten long driving days (keep ≥1 day at destination)
  if (pace === 'relaxed') {
    let guard = 20;
    while (rest > 1 && guard--) {
      let j = -1, load = 0;
      k.forEach((kk, i) => { const l = hrs[i] / kk; if (l > load) { load = l; j = i; } });
      if (load < 0.7 * maxS) break;
      k[j]++; rest--;
    }
  }

  // targets (absolute time along route) where each driving day should end
  const segments = journeys.map(([a, b], j) => {
    const t0 = time[a], span = time[b] - time[a];
    const targets = [];
    for (let i = 1; i < k[j]; i++) targets.push(t0 + (span * i) / k[j]);
    return { a, b, k: k[j], targets };
  });
  const restAt = roundTrip && journeys.length === 2 ? 'middle' : 'end';
  return { segments, rest: Math.max(0, rest), restAt, warnings, maxS };
}

// Pick a real town for each split target.
export function snapTargets(segments, timeline, towns, maxS) {
  const { coords, time } = timeline;
  for (const seg of segments) {
    seg.splits = [];
    let prevI = seg.a;
    for (const t of seg.targets) {
      // geometry index at target time
      let ti = prevI;
      while (ti < seg.b && time[ti] < t) ti++;
      const target = coords[ti];
      let best = null, bestScore = Infinity;
      for (const town of towns) {
        if (haversine(target, [town.lat, town.lon]) > 45000) continue;
        // where does this town sit on our route (only look at the stretch after the previous halt)
        let ni = prevI + 1, nd = Infinity;
        const lo = Math.max(prevI + 1, ti - 4000), hi = Math.min(seg.b - 1, ti + 4000);
        for (let i = lo; i <= hi; i++) {
          const d = haversine(coords[i], [town.lat, town.lon]);
          if (d < nd) { nd = d; ni = i; }
        }
        if (nd > 15000 || ni <= prevI || ni >= seg.b) continue;
        const dayLen = time[ni] - time[prevI];
        const overBy = Math.max(0, dayLen - maxS);
        const score = Math.abs(time[ni] - t) / 3600 + nd / 15000 + overBy / 1800
          - (town.place === 'city' ? 0.35 : 0) - Math.min(0.3, Math.log10(1 + town.population) / 20);
        if (score < bestScore) { bestScore = score; best = { ...town, i: ni, off: nd }; }
      }
      if (!best) best = { name: null, lat: target[0], lon: target[1], i: ti, off: 0 };
      seg.splits.push(best);
      prevI = best.i;
    }
  }
  return segments;
}

// Build the final list of day objects.
export function buildDays({ segments, rest, restAt, timeline, waypoints, destIndex, startDate, pace, maxS }) {
  const { coords, dist, time, wpIdx } = timeline;
  const P = PACE[pace];
  const days = [];
  const stopAt = (lo, hi) => waypoints
    .map((w, i) => ({ ...w, gi: wpIdx[i], i }))
    .filter((w) => w.i > 0 && w.i < waypoints.length - 1 && w.gi > lo && w.gi <= hi && w.i !== destIndex);

  const pushDrive = (a, b, from, to) => {
    const driveS = time[b] - time[a];
    const breaks = Math.floor(driveS / 3600 / P.breakEvery);
    const meal = driveS > 4 * 3600 ? 45 * 60 : 0;
    days.push({
      type: 'drive', from, to, a, b,
      distM: dist[b] - dist[a], driveS, breaks,
      totalS: driveS + breaks * P.breakMin * 60 + meal,
      overMin: Math.max(0, Math.round((driveS - maxS) / 60)),
      stops: stopAt(a, b).map((s) => s.name),
    });
  };
  const pushRest = (at) => days.push({ type: 'rest', from: at, to: at, distM: LOCAL_KM_PER_REST_DAY * 1000, driveS: 0, totalS: 0 });

  let here = { ...waypoints[0] };
  segments.forEach((seg, si) => {
    let a = seg.a;
    seg.splits.forEach((s) => {
      const to = { name: s.name, lat: s.lat, lon: s.lon, needsName: !s.name, halt: true };
      pushDrive(a, s.i, here, to);
      here = to; a = s.i;
    });
    const endWp = si === 0 && segments.length === 2 ? waypoints[destIndex] : waypoints[waypoints.length - 1];
    const to = { ...endWp, halt: true };
    pushDrive(a, seg.b, here, to);
    here = to;
    if (si === 0 && restAt === 'middle') for (let r = 0; r < rest; r++) pushRest(here);
  });
  if (restAt === 'end') for (let r = 0; r < rest; r++) pushRest(here);

  days.forEach((d, i) => {
    d.index = i;
    d.date = addDays(startDate, i);
    d.iso = isoDate(d.date);
  });
  // The final day ends the trip; no night halt needed.
  const last = days[days.length - 1];
  if (last) last.final = true;
  return days;
}

// ---------------- costs ----------------
export function computeCosts({ inputs, days, routeM, rates }) {
  const V = VEHICLES[inputs.vehicle];
  const people = inputs.people;
  const vehicles = Math.max(1, Math.ceil(people / V.seats));
  const restDays = days.filter((d) => d.type === 'rest').length;
  const totalKm = routeM / 1000 + restDays * LOCAL_KM_PER_REST_DAY;
  const litres = (totalKm / (rates.mileage || inputs.mileage || V.mileage)) * vehicles;
  const nights = Math.max(0, days.length - 1);
  const rooms = Math.max(1, Math.ceil(people / 2));
  const fuel = litres * rates.fuelPrice;
  const stay = rooms * nights * rates.room;
  const food = people * days.length * rates.food;
  const tolls = V.toll ? (routeM / 1000) * rates.tollPerKm * vehicles : 0;
  const subtotal = fuel + stay + food + tolls;
  const buffer = rates.buffer ? subtotal * 0.1 : 0;
  const total = subtotal + buffer;
  return { vehicles, totalKm, litres, nights, rooms, fuel, stay, food, tolls, buffer, total, perPerson: total / people, restDays };
}

// ---------------- weather helpers ----------------
export const WMO = (c) => {
  if (c == null) return ['❔', 'No data'];
  if (c === 0) return ['☀️', 'Clear sky'];
  if (c <= 2) return ['🌤️', 'Mostly clear'];
  if (c === 3) return ['☁️', 'Overcast'];
  if (c <= 48) return ['🌫️', 'Fog'];
  if (c <= 55) return ['🌦️', 'Drizzle'];
  if (c <= 57) return ['🌧️', 'Freezing drizzle'];
  if (c <= 65) return ['🌧️', c >= 65 ? 'Heavy rain' : 'Rain'];
  if (c <= 67) return ['🌧️', 'Freezing rain'];
  if (c <= 77) return ['🌨️', 'Snow'];
  if (c <= 82) return ['🌦️', 'Rain showers'];
  if (c <= 86) return ['🌨️', 'Snow showers'];
  return ['⛈️', 'Thunderstorm'];
};

export function dayAdvice(day, wx) {
  const notes = [];
  if (!wx) return notes;
  if (wx.min != null && wx.min <= 0) notes.push({ level: 'warn', text: `❄️ Sub-zero night (${Math.round(wx.min)}°) — hill roads can be icy after 4 pm` });
  else if (wx.min != null && wx.min <= 5) notes.push({ level: 'info', text: `🧥 Cold night (${Math.round(wx.min)}°) — keep jackets handy` });
  if (wx.code >= 71 && wx.code <= 86) notes.push({ level: 'warn', text: '🌨️ Snow possible — carry chains, check if passes are open' });
  if (wx.code >= 95) notes.push({ level: 'warn', text: '⛈️ Thunderstorms — avoid ghat roads in heavy rain' });
  else if ((wx.rainProb ?? 0) >= 60 || wx.rain >= 10) notes.push({ level: 'warn', text: '🌧️ Wet day — drive slower, watch for landslides in hills' });
  if (wx.code === 45 || wx.code === 48) notes.push({ level: 'info', text: '🌫️ Morning fog likely — start after it lifts (~9 am)' });
  if (wx.max != null && wx.max >= 38) notes.push({ level: 'warn', text: `🥵 Very hot (${Math.round(wx.max)}°) — check coolant, carry extra water` });
  return notes;
}

// Leave-by time so you arrive ~20 minutes before sunset.
export function leaveBy(day, wx) {
  if (!wx?.sunset || day.type !== 'drive') return null;
  const sunset = new Date(wx.sunset);
  const sunrise = wx.sunrise ? new Date(wx.sunrise) : null;
  const t = new Date(sunset.getTime() - day.totalS * 1000 - 20 * 60000);
  const early = new Date(sunset); early.setHours(5, 30, 0, 0);
  if (t < early) {
    const darkMin = Math.round((early.getTime() + day.totalS * 1000 - sunset.getTime()) / 60000);
    return { time: early, dark: darkMin, sunrise, sunset };
  }
  return { time: t, dark: 0, sunrise, sunset };
}

// Departure/arrival for a driving day. mode 'leave' anchors the start time,
// 'reach' anchors the arrival time. totalS includes breaks and a meal stop.
export function dayTimes(day, mode, hm) {
  const [hh, mm] = String(hm || '07:00').split(':').map(Number);
  const anchor = new Date(day.date); anchor.setHours(hh, mm, 0, 0);
  const ms = (day.totalS || 0) * 1000;
  return mode === 'reach'
    ? { depart: new Date(anchor.getTime() - ms), arrive: anchor }
    : { depart: anchor, arrive: new Date(anchor.getTime() + ms) };
}

// ---------------- packing ----------------
export function packingList({ inputs, days, weather, routeM }) {
  const n = inputs.people;
  const bike = inputs.vehicle === 'bike';
  const ws = weather.filter(Boolean);
  const minT = ws.length ? Math.min(...ws.map((w) => w.min)) : null;
  const maxT = ws.length ? Math.max(...ws.map((w) => w.max)) : null;
  const wet = ws.some((w) => (w.rainProb ?? 0) >= 50 || w.rain >= 5);
  const snow = ws.some((w) => w.code >= 71 && w.code <= 86);
  const highAlt = ws.some((w) => (w.elevation || 0) >= 1500);
  const nights = Math.max(0, days.length - 1);
  const items = [
    { id: 'docs', cat: 'Documents', text: bike ? 'Driving licence, RC, PUC, insurance (per bike)' : 'Driving licence, RC, PUC, insurance' },
    { id: 'id', cat: 'Documents', text: `ID proof for all ${n} travellers`, tag: 'hotel check-in' },
    !bike && { id: 'fastag', cat: 'Vehicle', text: 'FASTag recharged', tag: 'tolls' },
    { id: 'spare', cat: 'Vehicle', text: bike ? 'Puncture kit & mini pump' : 'Spare tyre, jack & wheel spanner' },
    routeM > 600000 && { id: 'service', cat: 'Vehicle', text: 'Service check: oil, coolant, brakes, tyre pressure', tag: `${Math.round(routeM / 1000)} km` },
    { id: 'chargers', cat: 'Gadgets', text: 'Phone chargers, car charger & power bank' },
    { id: 'offline', cat: 'Gadgets', text: 'Download offline maps for the route', tag: 'patchy network' },
    { id: 'water', cat: 'Food', text: `Water bottles × ${n}`, tag: `${n} people` },
    { id: 'snacks', cat: 'Food', text: 'Road snacks & a small trash bag' },
    { id: 'clothes', cat: 'Clothes', text: `Clothes for ${days.length} day${days.length > 1 ? 's' : ''} × ${n}` },
    { id: 'firstaid', cat: 'Health', text: 'First-aid kit & personal medicines' },
    { id: 'cash', cat: 'Money', text: 'Some cash for dhabas & small towns', tag: 'UPI may fail' },
    nights > 0 && { id: 'toiletries', cat: 'Health', text: 'Toiletries & quick-dry towel' },
    bike && { id: 'helmet', cat: 'Riding', text: 'Helmets (ISI) × ' + n, tag: 'must' },
    bike && { id: 'gear', cat: 'Riding', text: 'Riding jacket, gloves & knee guards' },
    bike && { id: 'bungee', cat: 'Riding', text: 'Bungee cords / saddle bags & rain cover' },
    minT != null && minT <= 10 && { id: 'warm', cat: 'Clothes', text: `Warm jackets × ${n}`, tag: `${Math.round(minT)}° expected` },
    minT != null && minT <= 3 && { id: 'thermals', cat: 'Clothes', text: `Thermal wear × ${n}, caps & gloves`, tag: `${Math.round(minT)}° nights` },
    (snow || (minT != null && minT <= 0)) && { id: 'chains', cat: 'Vehicle', text: 'Snow chains / anti-skid & de-icer', tag: 'icy roads' },
    snow && { id: 'boots', cat: 'Clothes', text: 'Waterproof shoes / snow boots', tag: 'snow' },
    highAlt && { id: 'motion', cat: 'Health', text: 'Motion-sickness tablets', tag: 'hill roads' },
    highAlt && { id: 'lipbalm', cat: 'Health', text: 'Lip balm & moisturiser', tag: 'dry air' },
    wet && { id: 'rain', cat: 'Clothes', text: `Raincoats / umbrellas × ${n}`, tag: 'rain likely' },
    wet && { id: 'ziplock', cat: 'Gadgets', text: 'Zip-lock bags for phones & documents', tag: 'rain' },
    maxT != null && maxT >= 30 && { id: 'sun', cat: 'Health', text: 'Sunscreen, sunglasses & caps', tag: `${Math.round(maxT)}° days` },
    maxT != null && maxT >= 34 && { id: 'ors', cat: 'Health', text: 'ORS packets / electrolytes', tag: 'heat' },
    days.length >= 4 && { id: 'laundry', cat: 'Clothes', text: 'Laundry bag' },
    { id: 'music', cat: 'Fun', text: 'Playlist downloaded & aux / Bluetooth ready' },
  ];
  return items.filter(Boolean);
}

// ---------------- bingo ----------------
const BINGO_BASE = [
  'Cow on the highway', 'Truck with poetry', '"Horn OK Please"', 'Dhaba with charpai', 'Wrong-side driver', 'Overloaded tractor',
  'Speed breaker with no paint', 'Chai stop', 'Lemon-chilli on bumper', 'Goat herd crossing', 'Temple on a hill', 'Someone falls asleep',
  'Toll plaza queue', 'Bike with 3 riders', '"Drive slow, live long" sign', 'Roadside maggi', 'Camel or donkey', 'Petrol pump with a café',
  'Car with a roof carrier', 'Bus with people on top', 'Monkey sighting', 'Bridge over a river', 'Someone sings along loudly', 'Pothole dodge',
  'Truck painted with eyes', '"Use Dipper at Night"', 'Sugarcane juice stall', 'Wedding procession', 'Policeman waving traffic', 'Tea garden or field',
];
const BINGO_HILLS = ['Hairpin bend', 'Snow-capped peak', 'Prayer flags', 'Landslide warning', 'Apple / orange orchard', 'Tunnel', 'Yak or mule', 'Waterfall by the road'];
const BINGO_HOT = ['Coconut water stall', 'Mirage on the road', 'Banana plantation', 'Beach glimpse'];

export function bingoCard({ hilly, hot, seed }) {
  let pool = BINGO_BASE.slice();
  if (hilly) pool = pool.concat(BINGO_HILLS, BINGO_HILLS.slice(0, 4));
  if (hot) pool = pool.concat(BINGO_HOT);
  const unique = [...new Set(shuffle(pool, seed))].slice(0, 15);
  unique.splice(5, 0, 'FREE ⭐');
  return unique;
}

export function bingoWin(marks) {
  // 4×4 grid
  const on = (r, c) => marks.includes(r * 4 + c);
  for (let i = 0; i < 4; i++) {
    if ([0, 1, 2, 3].every((c) => on(i, c))) return true;
    if ([0, 1, 2, 3].every((r) => on(r, i))) return true;
  }
  return [0, 1, 2, 3].every((i) => on(i, i)) || [0, 1, 2, 3].every((i) => on(i, 3 - i));
}

export function nightsCount(start, end) {
  return Math.round((parseDate(end) - parseDate(start)) / 86400000);
}
