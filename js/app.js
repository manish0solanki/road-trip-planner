import {
  $, $$, h, esc, rupees, num, km, dur, clock, isoDate, parseDate, addDays, fmtDay, fmtShort, fmtRange,
  haversine, nearestIndex, debounce, uid, b64urlEncode, b64urlDecode, toast,
} from './util.js';
import * as api from './api.js';
import {
  VEHICLES, PACE, BUDGET, ROAD_BUFFER, TOLL_PER_KM, defaultTitle, short, buildTimeline, allocate, snapTargets, buildDays,
  computeCosts, WMO, dayAdvice, leaveBy, dayTimes, packingList, bingoCard, bingoWin, nightsCount,
} from './planner.js';

/* =====================================================================
   STATE
   ===================================================================== */
const today = new Date(); today.setHours(0, 0, 0, 0);
const form = {
  places: [{ name: '' }, { name: '' }],
  roundTrip: true,
  start: isoDate(addDays(today, 7)),
  end: isoDate(addDays(today, 11)),
  people: 4,
  vehicle: 'suv',
  mileage: VEHICLES.suv.mileage,
  mileageEdited: false,
  fuelPrice: 95,
  maxHours: 6,
  pace: 'balanced',
  budget: 'comfort',
  timeMode: 'leave',
  time: '07:00',
};
const DEFAULT_TIME = { leave: '07:00', reach: '17:00' };
let trip = null;         // current planned trip (see plan())
let planToken = 0;       // cancels stale async work when a new plan starts
let lastInputs = null;   // for "Try again"

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast('Could not save — browser storage is full or blocked'); } },
};

/* =====================================================================
   FORM
   ===================================================================== */
const DOT = { start: '#0f4c4a', stop: 'var(--sun)', end: 'var(--orange)' };

function roleOf(i) { return i === 0 ? 'start' : i === form.places.length - 1 ? 'end' : 'stop'; }

function renderPlaces() {
  const box = $('#places');
  box.innerHTML = '';
  form.places.forEach((p, i) => {
    const role = roleOf(i);
    const input = h('input', {
      class: 'inp', type: 'text', autocomplete: 'off', spellcheck: 'false', value: p.name ? (p.detail ? `${p.name}, ${p.detail}` : p.name) : '',
      placeholder: role === 'start' ? 'Starting from… e.g. New Delhi' : role === 'end' ? 'Destination… e.g. Manali' : 'Stop on the way…',
      'aria-label': role === 'start' ? 'Start' : role === 'end' ? 'Destination' : `Stop ${i}`,
      role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
    });
    const tools = h('div', { class: 'tools' });
    if (role === 'start') tools.append(h('button', { type: 'button', title: 'Use my location', 'aria-label': 'Use my location', onclick: () => locate(i) }, '📍'));
    if (role === 'stop') tools.append(h('button', { type: 'button', title: 'Remove stop', 'aria-label': 'Remove stop', onclick: () => { form.places.splice(i, 1); renderPlaces(); } }, '✕'));
    if (role === 'end') tools.append(h('button', { type: 'button', title: 'Swap start and destination', 'aria-label': 'Swap start and destination', onclick: () => {
      const n = form.places.length - 1; [form.places[0], form.places[n]] = [form.places[n], form.places[0]]; renderPlaces();
    } }, '⇅'));
    const wrap = h('div', { class: 'place' + (p.lat != null ? ' ok' : '') }, h('span', { class: 'dot', style: `background:${DOT[role]}` }), input, tools);
    box.append(wrap);
    attachAutocomplete(input, i, wrap);
  });
  $('#addStop').hidden = form.places.length >= 7;
}

function attachAutocomplete(input, i, wrap) {
  let list = null, items = [], active = -1, ctrl = null;
  const close = () => { list?.remove(); list = null; active = -1; input.setAttribute('aria-expanded', 'false'); };
  const choose = (r) => {
    form.places[i] = { name: r.name, detail: r.detail, lat: r.lat, lon: r.lon };
    input.value = r.detail ? `${r.name}, ${r.detail}` : r.name;
    wrap.classList.add('ok');
    close();
  };
  const show = (results, msg) => {
    close();
    items = results;
    list = h('div', { class: 'suggest', role: 'listbox' });
    if (!results.length) list.append(h('div', { class: 'none' }, msg || 'No matches — try a nearby town or add the state'));
    results.forEach((r, k) => list.append(h('button', { type: 'button', role: 'option', onmousedown: (e) => { e.preventDefault(); choose(r); } }, r.name, h('small', {}, r.detail || ''))));
    wrap.append(list);
    input.setAttribute('aria-expanded', 'true');
  };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 3) return close();
    ctrl?.abort(); ctrl = new AbortController();
    try { show(await api.searchPlaces(q, ctrl.signal)); }
    catch (e) { if (e.name !== 'AbortError') show([], 'Search is offline — you can still type the full name and press Plan'); }
  }, 350);
  input.addEventListener('input', () => {
    form.places[i] = { name: input.value.trim() };
    wrap.classList.remove('ok');
    search();
  });
  input.addEventListener('keydown', (e) => {
    if (!list || !items.length) return;
    const btns = $$('button', list);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns.forEach((b, k) => b.classList.toggle('active', k === active));
    } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

async function locate(i) {
  if (!navigator.geolocation) return toast('Location is not available in this browser');
  toast('Finding you…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    let name = 'My location', detail = '';
    try { ({ name, detail } = await api.reverse(lat, lon)); } catch {}
    form.places[i] = { name, detail, lat, lon };
    renderPlaces();
  }, () => toast('Could not get your location — please type it'), { timeout: 10000 });
}

function setupChips(container, field, options, onChange) {
  container.innerHTML = '';
  for (const [value, o] of Object.entries(options)) {
    container.append(h('button', { type: 'button', class: 'chip', role: 'radio', 'data-value': value, onclick: () => { form[field] = value; syncForm(); onChange?.(value); } }, `${o.icon} ${o.label}`));
  }
}

function syncForm() {
  $$('.chips[data-field]').forEach((c) => {
    const f = c.dataset.field, val = String(form[f]);
    $$('.chip', c).forEach((b) => { const on = b.dataset.value === val; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  });
  $('#startDate').value = form.start;
  $('#endDate').value = form.end;
  $('#pplVal').textContent = form.people;
  $('#pplWord').textContent = form.people === 1 ? 'person' : 'people';
  $('#mileage').value = form.mileage;
  $('#fuelPrice').value = form.fuelPrice;
  $('#maxHours').value = form.maxHours;
  $('#timeVal').value = form.time;
  $('#timeHint').textContent = form.time
    ? (form.timeMode === 'leave' ? `Start driving at ${fmtTime(form.time)} on each driving day` : `Reach each halt by ${fmtTime(form.time)} — we'll tell you when to leave`)
    : '';
  $('#maxHoursVal').textContent = `${form.maxHours} hours`;
  const nights = nightsCount(form.start, form.end);
  $('#daysHint').textContent = nights >= 0 ? `${nights + 1} day${nights ? 's' : ''}, ${nights} night${nights === 1 ? '' : 's'}` : 'End date is before start date';
  const V = VEHICLES[form.vehicle];
  const veh = Math.ceil(form.people / V.seats);
  $('#vehHint').textContent = `${V.seats} seats each → ${veh} × ${V.label} for ${form.people} ${form.people === 1 ? 'person' : 'people'}`;
}

function bindForm() {
  setupChips($('#vehicleChips'), 'vehicle', VEHICLES, (v) => { if (!form.mileageEdited) form.mileage = VEHICLES[v].mileage; syncForm(); });
  setupChips($('#paceChips'), 'pace', PACE);
  setupChips($('#budgetChips'), 'budget', BUDGET);
  $$('.chips[data-field="roundTrip"] .chip').forEach((b) => b.addEventListener('click', () => { form.roundTrip = b.dataset.value === 'true'; syncForm(); }));
  $$('.chips[data-field="timeMode"] .chip').forEach((b) => b.addEventListener('click', () => {
    const m = b.dataset.value;
    if (m !== form.timeMode && form.time === DEFAULT_TIME[form.timeMode]) form.time = DEFAULT_TIME[m];
    form.timeMode = m; syncForm();
  }));
  $('#timeVal').addEventListener('change', (e) => { form.time = e.target.value; syncForm(); });
  $('#addStop').addEventListener('click', () => { form.places.splice(form.places.length - 1, 0, { name: '' }); renderPlaces(); $$('#places .inp')[form.places.length - 2]?.focus(); });
  $('#startDate').addEventListener('change', (e) => {
    const len = Math.max(0, nightsCount(form.start, form.end));
    form.start = e.target.value;
    if (nightsCount(form.start, form.end) < 0) form.end = isoDate(addDays(parseDate(form.start), len));
    syncForm();
  });
  $('#endDate').addEventListener('change', (e) => { form.end = e.target.value; syncForm(); });
  $('#pplMinus').addEventListener('click', () => { form.people = Math.max(1, form.people - 1); syncForm(); });
  $('#pplPlus').addEventListener('click', () => { form.people = Math.min(30, form.people + 1); syncForm(); });
  $('#mileage').addEventListener('input', (e) => { form.mileage = +e.target.value; form.mileageEdited = true; });
  $('#fuelPrice').addEventListener('input', (e) => { form.fuelPrice = +e.target.value; });
  $('#maxHours').addEventListener('input', (e) => { form.maxHours = +e.target.value; $('#maxHoursVal').textContent = `${form.maxHours} hours`; });
  $('#tripForm').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

function validate() {
  const err = [];
  form.places.forEach((p, i) => { if (!p.name?.trim()) err.push(`Please fill in the ${roleOf(i) === 'start' ? 'start' : roleOf(i) === 'end' ? 'destination' : 'empty stop (or remove it)'}.`); });
  const n = nightsCount(form.start, form.end);
  if (!form.start || !form.end || isNaN(n)) err.push('Please pick your dates.');
  else if (n < 0) err.push('End date must be on or after the start date.');
  else if (n > 29) err.push('Trips can be up to 30 days long.');
  if (!/^\d\d:\d\d$/.test(form.time || '')) err.push(form.timeMode === 'leave' ? 'Please pick a time to leave.' : 'Please pick a time to reach.');
  if (!(form.mileage > 0)) err.push('Please enter your vehicle mileage (km/l).');
  if (!(form.fuelPrice > 0)) err.push('Please enter the fuel price.');
  return err;
}

function submit() {
  const errs = validate();
  const box = $('#formErr');
  if (errs.length) { box.textContent = errs[0]; box.hidden = false; return; }
  box.hidden = true;
  const inputs = JSON.parse(JSON.stringify({ ...form }));
  plan(inputs);
  if (matchMedia('(max-width: 760px)').matches) setTimeout(() => $('#main').scrollIntoView({ behavior: 'smooth' }), 50);
}

/* =====================================================================
   PLANNING
   ===================================================================== */
const STEPS = ['Finding your places', 'Drawing the road route', 'Splitting into days & night halts', 'Packing the car'];
function setStep(k) {
  $('#loadSteps').innerHTML = STEPS.map((s, i) => `<li class="${i < k ? 'done' : i === k ? 'now' : ''}">${i < k ? '✓' : i === k ? '➜' : '○'} ${s}</li>`).join('');
}
function showOnly(id) { ['emptyState', 'loading', 'errorBox', 'results'].forEach((x) => ($('#' + x).hidden = x !== id)); }

async function plan(inputs, saved = null) {
  const token = ++planToken;
  inputs.timeMode ||= 'leave';
  inputs.time ||= DEFAULT_TIME[inputs.timeMode];
  lastInputs = inputs;
  showOnly('loading');
  $('#planBtn').disabled = true;
  try {
    setStep(0);
    const places = [];
    for (const p of inputs.places) places.push(p.lat != null ? p : { ...(await api.geocode(p.name)), typed: p.name });
    inputs.places = places;
    if (token !== planToken) return;

    setStep(1);
    const waypoints = inputs.roundTrip ? [...places, places[0]] : places.slice();
    const destIndex = places.length - 1;
    const route = await api.route(waypoints);
    if (token !== planToken) return;
    if (route.distance < 1000) throw new Error('Start and destination are the same place — pick somewhere to drive to!');

    setStep(2);
    const V = VEHICLES[inputs.vehicle];
    const timeline = buildTimeline(route, waypoints, ROAD_BUFFER * V.speed);
    const nDays = nightsCount(inputs.start, inputs.end) + 1;
    const alloc = allocate({ timeline, waypoints, roundTrip: inputs.roundTrip, destIndex, nDays, maxHours: inputs.maxHours, pace: inputs.pace });
    const targetPts = alloc.segments.flatMap((s) => s.targets.map((t) => { let i = s.a; while (i < s.b && timeline.time[i] < t) i++; return timeline.coords[i]; }));
    let towns = [];
    if (targetPts.length) { try { towns = await api.townsNear(targetPts); } catch (e) { console.warn('towns lookup failed', e); } }
    snapTargets(alloc.segments, timeline, towns, alloc.maxS);
    const days = buildDays({ ...alloc, timeline, waypoints, destIndex, startDate: parseDate(inputs.start), pace: inputs.pace, maxS: alloc.maxS });
    // name any halt we couldn't snap to a town
    for (const d of days) if (d.to.needsName) {
      try { const r = await api.reverse(d.to.lat, d.to.lon); d.to.name = r.name; d.to.detail = r.detail; } catch { d.to.name = `Halt near km ${Math.round(timeline.dist[d.b] / 1000)}`; }
      d.to.needsName = false;
    }
    if (token !== planToken) return;

    setStep(3);
    const B = BUDGET[inputs.budget];
    trip = {
      id: saved?.id || uid(),
      saved: !!saved?.id,
      shared: !!saved && !saved.id,
      title: saved?.title || defaultTitle(places, parseDate(inputs.start), inputs.roundTrip),
      inputs, route, timeline, waypoints, destIndex, days,
      warnings: alloc.warnings,
      rates: saved?.rates || { fuelPrice: inputs.fuelPrice, mileage: inputs.mileage, room: B.room, food: B.food, tollPerKm: TOLL_PER_KM, buffer: false },
      pins: saved?.pins || {}, packed: saved?.packed || {}, custom: saved?.custom || [], times: saved?.times || {},
      bingo: saved?.bingo || { seed: Math.floor(Math.random() * 1e9), marks: [5] },
      weather: days.map(() => undefined), // undefined = loading, null = unavailable
      pois: days.map(() => undefined),
      stays: undefined, wiki: {},
      stayView: { block: 0, type: 'all', contact: false, near: false, more: false },
    };
    lastInputs = null;
    renderResults();
    $('#planBtn').disabled = false;
    history.replaceState(null, '', location.pathname + '#trip=' + shareCode());
    enrich();
  } catch (e) {
    if (token !== planToken) return;
    console.error(e);
    $('#errorMsg').textContent = e.name === 'AbortError' ? 'A map service took too long to answer. Please try again.' : (e.message || String(e));
    showOnly('errorBox');
    $('#planBtn').disabled = false;
  }
}

// Background enrichment: weather → stays → sights/fuel → wiki.
// Each loader can be re-run on its own from a "Retry" button.
const alive = (t) => trip === t;

async function loadWeather(t = trip) {
  t.weather = t.days.map(() => undefined);
  renderDays();
  try {
    const w = await api.weatherFor(t.days.map((d) => ({ lat: d.to.lat, lon: d.to.lon, date: d.iso })));
    if (!alive(t)) return;
    t.weather = w.map((x) => x || null);
  } catch (e) { console.warn(e); if (!alive(t)) return; t.weather = t.days.map(() => null); }
  renderDays(); renderPacking(); renderStats(); renderFun();
}

async function loadStays(t = trip) {
  const blocks = nightBlocks();
  if (!blocks.length) { t.stays = []; return; }
  t.stays = undefined;
  renderStays(); renderDays();
  try {
    const all = await api.staysNear(blocks.map((b) => b.place));
    if (!alive(t)) return;
    t.stays = blocks.map((b) => all
      .map((s) => ({ ...s, dist: haversine([s.lat, s.lon], [b.place.lat, b.place.lon]) }))
      .filter((s) => s.dist <= 26000)
      .filter((s, i, arr) => arr.findIndex((x) => x.id === s.id || (x.name.toLowerCase() === s.name.toLowerCase() && haversine([x.lat, x.lon], [s.lat, s.lon]) < 300)) === i));
  } catch (e) { console.warn(e); if (!alive(t)) return; t.stays = null; }
  renderStays(); renderDays(); renderMapStays();
}

async function loadPois(i, t = trip) {
  const d = t.days[i];
  if (d.type !== 'drive') { t.pois[i] = { sights: [], fuel: [], food: [] }; return; }
  t.pois[i] = undefined;
  renderDay(i);
  try {
    const slice = t.timeline.coords.slice(d.a, d.b + 1);
    const res = await api.poisAlong(slice);
    res.fuel.forEach((f) => { f.km = t.timeline.dist[d.a + nearestIndex(slice, [f.lat, f.lon])] / 1000; });
    if (!alive(t)) return;
    t.pois[i] = res;
  } catch (e) { console.warn(e); if (!alive(t)) return; t.pois[i] = null; }
  renderDay(i); renderMapPOIs(); renderFuel();
}

async function loadWiki(key, place, t = trip) {
  t.wiki[key] = undefined;
  renderDays();
  try { const r = await api.wikiNear(place.lat, place.lon); if (!alive(t)) return; t.wiki[key] = r; }
  catch (e) { console.warn(e); if (!alive(t)) return; t.wiki[key] = null; }
  renderDays();
}

async function retryFailedPois(t = trip) {
  for (let i = 0; i < t.days.length; i++) if (t.pois[i] === null && alive(t)) await loadPois(i, t);
}

async function enrich() {
  const t = trip;
  loadWeather(t);
  await loadStays(t);
  for (let i = 0; i < t.days.length && alive(t); i++) await loadPois(i, t);
  const wikiPlaces = new Map();
  t.days.forEach((d) => { if (d.type === 'rest') wikiPlaces.set(placeKey(d.to), d.to); });
  for (const [k, p] of wikiPlaces) if (alive(t)) await loadWiki(k, p, t);
}

const retryBtn = (label, fn) => h('button', { type: 'button', class: 'retry', onclick: (e) => { e.stopPropagation(); fn(); } }, `🔄 ${label}`);
const fmtTime = (hm) => { const [a, b] = hm.split(':').map(Number); const d = new Date(); d.setHours(a, b, 0, 0); return clock(d); };

const placeKey = (p) => `${(+p.lat).toFixed(3)},${(+p.lon).toFixed(3)}`;

/* =====================================================================
   RESULTS RENDERING
   ===================================================================== */
function renderResults() {
  showOnly('results');
  $('#tripTitle').textContent = trip.title;
  const I = trip.inputs, V = VEHICLES[I.vehicle];
  const costs = computeCosts({ inputs: I, days: trip.days, routeM: trip.route.distance, rates: trip.rates });
  $('#tripMeta').textContent = `${fmtRange(parseDate(I.start), parseDate(I.end))} · ${trip.days.length} day${trip.days.length > 1 ? 's' : ''} · ${I.people} traveller${I.people > 1 ? 's' : ''} · ${costs.vehicles} ${V.label}${costs.vehicles > 1 ? 's' : ''}`;
  $('#readyNote').textContent = trip.saved ? 'Saved trip 💾' : trip.shared ? 'Shared trip 🔗' : 'Your plan is ready ✨';
  $('#saveBtn').textContent = trip.saved ? '✓ Saved' : '💾 Save trip';
  const viaNames = trip.inputs.places.slice(1, -1).map((p) => short(p.name));
  $('#mapTag').textContent = `🛣️ ${viaNames.length ? 'via ' + viaNames.join(', ') + ' · ' : ''}${km(trip.route.distance)}${I.roundTrip ? ' round trip' : ''}`;
  $('#warnings').innerHTML = trip.warnings.map((w) => `<div class="banner">⚠️ ${esc(w)}</div>`).join('');
  selectTab('itinerary');
  renderStats(); renderMap(); renderDays(); renderStays(); renderCosts(); renderPacking(); renderFuel(); renderFun();
  updateTripCount();
}

function renderStats() {
  const drive = trip.days.filter((d) => d.type === 'drive');
  const driveS = drive.reduce((s, d) => s + d.driveS, 0);
  const c = computeCosts({ inputs: trip.inputs, days: trip.days, routeM: trip.route.distance, rates: trip.rates });
  trip.costs = c;
  $('#stats').innerHTML = [
    ['Total distance', km(trip.route.distance), `${drive.length} driving day${drive.length > 1 ? 's' : ''}`],
    ['Time at the wheel', dur(driveS), `avg ${num(driveS / 3600 / drive.length, 1)} h / day`],
    ['Estimated total', rupees(c.total), 'fuel · stay · food · tolls'],
    ['Per person', rupees(c.perPerson), `split ${trip.inputs.people} way${trip.inputs.people > 1 ? 's' : ''}`],
  ].map(([a, b, e]) => `<div class="stat"><small>${a}</small><b>${b}</b><em>${e}</em></div>`).join('');
}

/* ---------- map ---------- */
let map, layers = {};
function ensureMap() {
  if (map) return map;
  map = L.map('map', { zoomControl: false, scrollWheelZoom: false });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  map.on('focus', () => map.scrollWheelZoom.enable());
  map.on('blur', () => map.scrollWheelZoom.disable());
  for (const k of ['route', 'pins', 'sights', 'fuel', 'stays', 'hl']) layers[k] = L.layerGroup().addTo(map);
  map.removeLayer(layers.fuel);
  $$('#mapLayers input').forEach((cb) => cb.addEventListener('change', () => {
    const l = layers[cb.dataset.layer];
    cb.checked ? l.addTo(map) : map.removeLayer(l);
  }));
  return map;
}
const icon = (cls, txt = '', size = 22) => L.divIcon({ className: '', html: `<div class="mk m-${cls}" style="width:${size}px;height:${size}px">${txt}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

function renderMap() {
  ensureMap();
  Object.values(layers).forEach((l) => l.clearLayers());
  const coords = trip.timeline.coords;
  L.polyline(coords, { color: '#0f4c4a', weight: 9, opacity: .25 }).addTo(layers.route);
  L.polyline(coords, { color: '#f26b1d', weight: 5, opacity: .95 }).addTo(layers.route);
  const P = trip.inputs.places;
  P.forEach((p, i) => {
    const cls = i === 0 ? 'start' : i === P.length - 1 ? 'end' : 'stop';
    L.marker([p.lat, p.lon], { icon: icon(cls, i === 0 ? 'A' : i === P.length - 1 ? 'B' : i, 26), zIndexOffset: 1000 })
      .bindTooltip(short(p.name), { direction: 'top', offset: [0, -12] }).addTo(layers.pins);
  });
  trip.days.forEach((d, i) => {
    if (d.type !== 'drive' || d.final || d.to === P[P.length - 1] || P.some((p) => p.lat === d.to.lat && p.lon === d.to.lon)) return;
    L.marker([d.to.lat, d.to.lon], { icon: icon('halt', '🛏', 26), zIndexOffset: 900 })
      .bindTooltip(`Night ${i + 1}: ${short(d.to.name)}`, { direction: 'top', offset: [0, -12] }).addTo(layers.pins);
  });
  setTimeout(() => { map.invalidateSize(); map.fitBounds(L.latLngBounds(coords), { padding: [30, 30] }); }, 30);
  renderMapPOIs(); renderMapStays();
}

function renderMapPOIs() {
  if (!map) return;
  layers.sights.clearLayers(); layers.fuel.clearLayers();
  trip.pois.forEach((p) => {
    if (!p) return;
    p.sights.slice(0, 8).forEach((s) => L.marker([s.lat, s.lon], { icon: icon('sight', '', 14) }).bindPopup(poiPopup(s)).addTo(layers.sights));
    p.food.slice(0, 4).forEach((s) => L.marker([s.lat, s.lon], { icon: icon('sight', '', 12) }).bindPopup(poiPopup(s, '🍛')).addTo(layers.sights));
    p.fuel.forEach((s) => L.marker([s.lat, s.lon], { icon: icon('fuel', '', 12) }).bindPopup(`<b>⛽ ${esc(s.name)}</b><br>km ${Math.round(s.km)} on route`).addTo(layers.fuel));
  });
}
function poiPopup(s, emoji = '📍') {
  const t = s.tags || {};
  const wiki = t.wikipedia ? `https://${t.wikipedia.split(':')[0]}.wikipedia.org/wiki/${encodeURIComponent(t.wikipedia.split(':').slice(1).join(':'))}` : '';
  return `<b>${emoji} ${esc(s.name)}</b><br><span style="color:var(--muted)">${esc((t.tourism || t.historic || t.natural || t.amenity || '').replace(/_/g, ' '))}</span>`
    + `<br><a href="${gmaps(s.lat, s.lon)}" target="_blank" rel="noopener">Google Maps</a>${wiki ? ` · <a href="${wiki}" target="_blank" rel="noopener">Wikipedia</a>` : ''}`;
}
function renderMapStays() {
  if (!map) return;
  layers.stays.clearLayers();
  if (!trip.stays) return;
  trip.stays.forEach((list, bi) => {
    const pin = trip.pins[blockKey(nightBlocks()[bi])];
    list.slice(0, 25).forEach((s) => {
      const pinned = pin?.id === s.id;
      L.marker([s.lat, s.lon], { icon: icon(pinned ? 'pinned' : 'stay', pinned ? '★' : '', pinned ? 18 : 11), zIndexOffset: pinned ? 800 : 0 })
        .bindPopup(`<b>${STAY_ICON[s.type] || '🏨'} ${esc(s.name)}</b><br>${esc(STAY_LABEL[s.type] || 'Stay')}${s.stars ? ' · ' + '★'.repeat(Math.round(s.stars)) : ''}<br><a href="${gmaps(s.lat, s.lon, s.name)}" target="_blank" rel="noopener">Google Maps</a>`)
        .addTo(layers.stays);
    });
  });
}

function focusDay(i) {
  const d = trip.days[i];
  $$('.day').forEach((el, k) => el.classList.toggle('active', k === i));
  layers.hl.clearLayers();
  if (d.type === 'drive') {
    const seg = trip.timeline.coords.slice(d.a, d.b + 1);
    L.polyline(seg, { color: '#0f4c4a', weight: 7, opacity: .9 }).addTo(layers.hl);
    map.fitBounds(L.latLngBounds(seg), { padding: [30, 30] });
  } else map.setView([d.to.lat, d.to.lon], 12);
  if (matchMedia('(max-width: 1100px)').matches) $('.mapbox').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ---------- itinerary ---------- */
const gmaps = (lat, lon, q) => `https://www.google.com/maps/search/?api=1&query=${q ? encodeURIComponent(q) : `${lat},${lon}`}`;
function navLink(d) {
  const pts = [d.from, ...trip.inputs.places.filter((p, k) => k > 0 && k < trip.inputs.places.length - 1 && d.stops.includes(p.name)), d.to];
  const f = (p) => `${(+p.lat).toFixed(5)},${(+p.lon).toFixed(5)}`;
  const way = pts.slice(1, -1).map(f).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${f(pts[0])}&destination=${f(pts[pts.length - 1])}${way ? '&waypoints=' + encodeURIComponent(way) : ''}&travelmode=driving`;
}

function renderDays() { const box = $('#days'); box.innerHTML = ''; trip.days.forEach((_, i) => box.append(dayCard(i))); }
function renderDay(i) { const old = $$('#days .day')[i]; if (old) old.replaceWith(dayCard(i)); }

function dayCard(i) {
  const d = trip.days[i], wx = trip.weather[i], pois = trip.pois[i];
  const card = h('article', { class: 'day', 'data-i': i });
  card.append(h('div', { class: 'dayhead', onclick: () => focusDay(i), title: 'Show on map' },
    h('span', { class: 'n' }, `DAY ${i + 1}`), h('span', { class: 'd' }, fmtDay(d.date))));
  const body = h('div', { class: 'daybody' });

  if (d.type === 'drive') {
    body.append(h('div', { class: 'leg' }, short(d.from.name), h('span', {}, ' → '), short(d.to.name)));
    if (d.stops.length) body.append(h('div', { class: 'via' }, `via ${d.stops.map(short).join(', ')}`));
    body.append(h('div', { class: 'meta', html: `<span>🛣️ <b>${km(d.distM)}</b></span><span>⏱️ <b>${dur(d.driveS)}</b></span><span>☕ ${d.breaks} break${d.breaks === 1 ? '' : 's'}</span>` }));
  } else {
    body.append(h('div', { class: 'leg' }, `Explore ${short(d.to.name)}`, h('span', {}, ' · rest day')));
    body.append(h('div', { class: 'meta', html: `<span>🛣️ <b>~30 km</b> local</span><span>🚶 at your pace</span>` }));
  }

  // timing: leave at / reach by
  if (d.type === 'drive') body.append(timingBlock(i, wx || null));

  // weather
  if (wx === undefined) body.append(h('div', { class: 'wx' }, h('div', { class: 'skeleton' })));
  else if (wx === null) body.append(h('div', { class: 'wx' }, h('span', { class: 'ic' }, '🌡️'), h('span', { class: 'hint' }, 'Weather didn’t load'), h('span', { style: 'margin-left:auto' }, retryBtn('Retry', () => loadWeather()))));
  else {
    const [ic, txt] = WMO(wx.code);
    body.append(h('div', { class: 'wx' },
      h('span', { class: 'ic' }, ic),
      h('div', {}, h('b', {}, `${Math.round(wx.max)}° / ${Math.round(wx.min)}°`), h('br'), h('span', { class: 'hint' }, txt),
        h('span', { class: 'src' }, wx.source === 'forecast' ? `Forecast · ${short(d.to.name)}` : `Last year on this date · ${short(d.to.name)}`)),
      h('div', { class: 'sun' }, `🌅 ${clock(new Date(wx.sunrise))}`, h('br'), `🌇 ${clock(new Date(wx.sunset))}`)));
    dayAdvice(d, wx).forEach((n) => body.append(h('div', { class: 'note ' + n.level }, n.text)));
  }
  if (d.overMin > 10) body.append(h('div', { class: 'note warn' }, `⚠️ ${dur(d.overMin * 60)} over your ${trip.inputs.maxHours} h limit — add a day or raise the limit`));

  // sights / food / fuel
  if (d.type === 'drive') {
    if (pois === undefined) body.append(h('div', { class: 'pois' }, h('div', { class: 'skeleton' })));
    else if (pois) {
      const row = h('div', { class: 'pois' });
      pois.sights.slice(0, 4).forEach((s) => row.append(poiBtn(s, 'g', sightEmoji(s))));
      pois.food.slice(0, 2).forEach((s) => row.append(poiBtn(s, '', '🍛')));
      if (pois.fuel.length) row.append(h('span', { class: 'poi s' }, `⛽ ${pois.fuel.length} fuel stop${pois.fuel.length > 1 ? 's' : ''}`));
      if (!row.children.length) row.append(h('span', { class: 'hint' }, 'Open road — no listed sights on this stretch'));
      body.append(row);
    } else body.append(h('div', { class: 'pois' }, h('span', { class: 'hint' }, 'Sights & fuel stops didn’t load'), retryBtn('Retry', () => loadPois(i))));
  } else {
    const list = trip.wiki[placeKey(d.to)];
    if (list === undefined) body.append(h('div', { class: 'pois' }, h('div', { class: 'skeleton' })));
    else if (list.length) {
      const w = h('div', { class: 'wiki' });
      list.slice(0, 4).forEach((p) => w.append(h('a', { href: p.url, target: '_blank', rel: 'noopener' },
        p.thumb ? h('img', { src: p.thumb, alt: '', loading: 'lazy' }) : h('span', { class: 'ph' }, '📍'),
        h('span', {}, p.title, h('small', {}, p.description)))));
      body.append(h('div', { class: 'hint' }, 'Things to see nearby'), w);
    } else if (list === null) body.append(h('div', { class: 'pois' }, h('span', { class: 'hint' }, 'Things to see didn’t load'), retryBtn('Retry', () => loadWiki(placeKey(d.to), d.to))));
  }

  // links
  const links = h('div', { class: 'daylinks' });
  if (d.type === 'drive') links.append(h('a', { href: navLink(d), target: '_blank', rel: 'noopener' }, '🧭 Navigate'));
  links.append(h('button', { type: 'button', onclick: () => focusDay(i) }, '🗺️ On map'));
  body.append(links);

  // night halt
  if (d.final) body.append(h('div', { class: 'halt' }, h('span', {}, '🏁 Trip ends'), h('b', {}, short(d.to.name))));
  else {
    const bi = nightBlocks().findIndex((b) => b.days.includes(i));
    const block = nightBlocks()[bi];
    const pin = trip.pins[blockKey(block)];
    const count = trip.stays?.[bi]?.length;
    const extra = pin ? `📌 ${pin.name}` : count ? `${count} stay${count > 1 ? 's' : ''} ›` : trip.stays === undefined ? '…' : trip.stays === null ? 'retry stays ›' : 'stays ›';
    body.append(h('div', { class: 'halt' },
      h('span', {}, '🛏 Night halt', h('button', { class: 'n2', type: 'button', onclick: () => { trip.stayView.block = bi; selectTab('stays'); renderStays(); } }, extra)),
      h('b', {}, short(d.to.name))));
  }
  card.append(body);
  return card;
}
// ---------- leave / reach timing ----------
function timingFor(i) {
  const o = trip.times[i];
  return { mode: o?.mode || trip.inputs.timeMode, time: o?.time || trip.inputs.time, custom: !!o };
}
function timingBlock(i, wx) {
  const d = trip.days[i];
  const tm = timingFor(i);
  const { depart, arrive } = dayTimes(d, tm.mode, tm.time);
  const dayShift = (t) => { const n = Math.round((new Date(t).setHours(0, 0, 0, 0) - new Date(d.date).setHours(0, 0, 0, 0)) / 864e5); return n ? ` (${n > 0 ? '+' : ''}${n} day)` : ''; };
  const wrap = h('div', { class: 'timingwrap' });
  const row = h('div', { class: 'timing' },
    h('div', { class: tm.mode === 'leave' ? 'fixed' : '' }, h('small', {}, '🕗 Leave'), h('b', {}, clock(depart) + dayShift(depart)), h('span', {}, short(d.from.name))),
    h('div', { class: 'mid' }, h('span', {}, dur(d.totalS)), h('small', {}, 'incl. breaks')),
    h('div', { class: 'end ' + (tm.mode === 'reach' ? 'fixed' : '') }, h('small', {}, '🏁 Reach'), h('b', {}, clock(arrive) + dayShift(arrive)), h('span', {}, short(d.to.name))),
    h('button', { type: 'button', class: 'edit', title: 'Change time for this day', 'aria-label': 'Change time for this day', 'aria-expanded': 'false', onclick: (e) => {
      const ed = wrap.querySelector('.timeedit'); ed.hidden = !ed.hidden; e.currentTarget.setAttribute('aria-expanded', String(!ed.hidden));
    } }, '✏️'));
  const ed = h('div', { class: 'timeedit', hidden: true },
    h('div', { class: 'chips' }, ['leave', 'reach'].map((m) => h('button', { type: 'button', class: 'chip' + (tm.mode === m ? ' on' : ''), onclick: () => setDayTime(i, m, tm.mode === m ? tm.time : DEFAULT_TIME[m]) }, m === 'leave' ? '🕗 Leave at' : '🏁 Reach by'))),
    h('input', { class: 'inp', type: 'time', value: tm.time, step: 900, 'aria-label': tm.mode === 'leave' ? 'Leave at' : 'Reach by', onchange: (e) => e.target.value && setDayTime(i, tm.mode, e.target.value) }),
    tm.custom ? h('button', { type: 'button', class: 'retry', onclick: () => { delete trip.times[i]; persist(); renderDay(i); } }, '↺ Use trip default') : null);
  wrap.append(row, ed);

  // sunlight advice for the chosen times
  if (wx?.sunset) {
    const sunset = new Date(wx.sunset), sunrise = wx.sunrise ? new Date(wx.sunrise) : null;
    const lb = leaveBy(d, wx);
    if (arrive > sunset) {
      const late = (arrive - sunset) / 1000;
      wrap.append(h('div', { class: 'note warn', html: lb && lb.dark <= 0
        ? `🌙 Reaches ${dur(late)} after sunset (${clock(sunset)}). Leave by <b>${clock(lb.time)}</b> to arrive in daylight.`
        : `🌙 Reaches ${dur(late)} after sunset (${clock(sunset)}) — a long day; some night driving is unavoidable.` }));
    } else wrap.append(h('div', { class: 'hint' }, `☀️ Arrives ${dur((sunset - arrive) / 1000)} before sunset (${clock(sunset)})`));
    if (sunrise && depart < sunrise) wrap.append(h('div', { class: 'note' }, `🌄 Starts before sunrise (${clock(sunrise)}) — first stretch in the dark`));
  }
  if (depart.getHours() < 4 && dayShift(depart) === '') wrap.append(h('div', { class: 'note warn' }, '😴 Very early start — make sure the driver sleeps well'));
  return wrap;
}
function setDayTime(i, mode, time) {
  if (mode === trip.inputs.timeMode && time === trip.inputs.time) delete trip.times[i];
  else trip.times[i] = { mode, time };
  persist(); renderDay(i);
  const ed = $$('#days .day')[i]?.querySelector('.timeedit');
  if (ed) { ed.hidden = false; ed.querySelector('input')?.focus(); }
}

const sightEmoji = (s) => {
  const t = s.tags || {};
  if (t.tourism === 'viewpoint') return '⛰️'; if (t.tourism === 'museum') return '🏛️'; if (t.historic === 'fort' || t.historic === 'castle') return '🏰';
  if (t.natural === 'waterfall') return '💧'; if (t.natural === 'beach') return '🏖️'; if (t.amenity === 'place_of_worship') return '🛕';
  if (t.natural === 'hot_spring') return '♨️'; if (t.tourism === 'zoo') return '🦁'; return '📍';
};
function poiBtn(s, cls, emoji) {
  return h('button', { type: 'button', class: 'poi ' + cls, title: s.name, onclick: () => {
    map.setView([s.lat, s.lon], 14);
    L.popup().setLatLng([s.lat, s.lon]).setContent(poiPopup(s, emoji)).openOn(map);
    if (matchMedia('(max-width: 1100px)').matches) $('.mapbox').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } }, `${emoji} ${s.name}`);
}

/* ---------- stays ---------- */
const STAY_LABEL = { hotel: 'Hotel', guest_house: 'Guest house / homestay', hostel: 'Hostel', motel: 'Motel', camp_site: 'Campsite', apartment: 'Apartment', chalet: 'Cottage', alpine_hut: 'Mountain hut', resort: 'Resort' };
const STAY_ICON = { hotel: '🏨', guest_house: '🏡', hostel: '🎒', motel: '🛣️', camp_site: '🏕️', apartment: '🏢', chalet: '🛖', alpine_hut: '🛖', resort: '🌴' };
const STAY_GROUP = { all: () => true, hotel: (s) => s.type === 'hotel' || s.type === 'motel', home: (s) => ['guest_house', 'apartment', 'chalet'].includes(s.type), hostel: (s) => s.type === 'hostel', camp: (s) => ['camp_site', 'alpine_hut'].includes(s.type), resort: (s) => s.type === 'resort' || s.stars >= 4 };
const STAY_GROUP_LABEL = { all: 'All', hotel: '🏨 Hotels', home: '🏡 Homestays', hostel: '🎒 Hostels', camp: '🏕️ Camps', resort: '✨ Resorts & 4★+' };

function fitsBudget(s, b) {
  if (b === 'budget') return ['hostel', 'camp_site', 'guest_house', 'alpine_hut', 'motel'].includes(s.type) || (s.type === 'hotel' && s.stars && s.stars <= 2);
  if (b === 'premium') return s.type === 'resort' || s.stars >= 4 || s.type === 'chalet';
  return ['hotel', 'guest_house', 'apartment', 'chalet', 'motel'].includes(s.type) && !(s.stars >= 5);
}

function nightBlocks() {
  if (trip._blocks) return trip._blocks;
  const blocks = [];
  trip.days.forEach((d, i) => {
    if (d.final) return;
    const last = blocks[blocks.length - 1];
    if (last && placeKey(last.place) === placeKey(d.to) && last.days[last.days.length - 1] === i - 1) last.days.push(i);
    else blocks.push({ place: d.to, days: [i] });
  });
  blocks.forEach((b) => {
    b.checkin = trip.days[b.days[0]].date;
    b.checkout = addDays(trip.days[b.days[b.days.length - 1]].date, 1);
    b.nights = b.days.length;
  });
  return (trip._blocks = blocks);
}
const blockKey = (b) => b ? `${placeKey(b.place)}|${isoDate(b.checkin)}` : '';

function bookingLinks(b) {
  const q = b.place.detail ? `${short(b.place.name)}, ${b.place.detail.split(',')[0]}` : short(b.place.name);
  const ci = isoDate(b.checkin), co = isoDate(b.checkout);
  const mdy = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${d.getFullYear()}`;
  const n = trip.inputs.people, rooms = Math.max(1, Math.ceil(n / 2));
  const per = Array.from({ length: rooms }, (_, k) => Math.min(2, n - k * 2) || 1);
  const qual = per.map((a) => `${a}e0e`).join('');
  return [
    ['🅱️', 'Booking.com', `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}&checkin=${ci}&checkout=${co}&group_adults=${n}&no_rooms=${rooms}&group_children=0`],
    ['✈️', 'MakeMyTrip', `https://www.makemytrip.com/hotels/hotel-listing/?checkin=${mdy(b.checkin)}&checkout=${mdy(b.checkout)}&searchText=${encodeURIComponent(q)}&roomStayQualifier=${qual}&country=IN`],
    ['🏠', 'Airbnb', `https://www.airbnb.co.in/s/${encodeURIComponent(q)}/homes?checkin=${ci}&checkout=${co}&adults=${n}`],
    ['🗺️', 'Google Maps hotels', `https://www.google.com/maps/search/hotels+near+${encodeURIComponent(q)}/@${(+b.place.lat).toFixed(4)},${(+b.place.lon).toFixed(4)},13z`],
  ];
}

function renderStays() {
  const box = $('#staysPanel');
  box.innerHTML = '';
  const blocks = nightBlocks();
  if (!blocks.length) { box.append(h('div', { class: 'card' }, h('h2', {}, '🛏 Where to stay'), h('p', { class: 'hint' }, 'This is a day trip — no overnight stays needed. 🎉'))); return; }
  const v = trip.stayView;
  v.block = Math.min(v.block, blocks.length - 1);
  const b = blocks[v.block];
  const rooms = Math.max(1, Math.ceil(trip.inputs.people / 2));
  const nightLbl = (bb) => `N${bb.days[0] + 1}${bb.nights > 1 ? '–' + (bb.days[bb.days.length - 1] + 1) : ''} · ${short(bb.place.name)}`;

  const card = h('div', { class: 'card stays' });
  card.append(h('div', { class: 'top' },
    h('h2', {}, '🛏 Where to stay'),
    h('span', { class: 'hint' }, `${b.nights > 1 ? 'Nights' : 'Night'} ${b.days[0] + 1}${b.nights > 1 ? '–' + (b.days[b.days.length - 1] + 1) : ''} · ${short(b.place.name)} · ${fmtShort(b.checkin)} → ${fmtShort(b.checkout)} · ${trip.inputs.people} guest${trip.inputs.people > 1 ? 's' : ''} · ${rooms} room${rooms > 1 ? 's' : ''}`),
    h('div', { class: 'nights' }, blocks.map((bb, k) => h('button', { type: 'button', class: 'chip' + (k === v.block ? ' on' : ''), onclick: () => { v.block = k; v.more = false; renderStays(); } }, nightLbl(bb))))));

  const list = trip.stays === undefined ? undefined : trip.stays === null ? null : trip.stays[v.block] || [];
  if (list) {
    const counts = Object.fromEntries(Object.keys(STAY_GROUP).map((k) => [k, list.filter(STAY_GROUP[k]).length]));
    card.append(h('div', { class: 'chips', style: 'margin:0 0 14px' },
      Object.keys(STAY_GROUP).filter((k) => k === 'all' || counts[k]).map((k) => h('button', { type: 'button', class: 'chip' + (v.type === k ? ' on' : ''), onclick: () => { v.type = k; renderStays(); } }, `${STAY_GROUP_LABEL[k]} (${counts[k]})`)),
      h('button', { type: 'button', class: 'chip' + (v.near ? ' on' : ''), onclick: () => { v.near = !v.near; renderStays(); } }, '📍 Within 3 km')));
  }

  const grid = h('div', { class: 'staygrid' });
  const sl = h('div', { class: 'staylist' });
  if (list === undefined) for (let k = 0; k < 4; k++) sl.append(h('div', { class: 'stay' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: 'width:40%' })));
  else if (list === null) sl.append(h('div', { class: 'emptylist' }, h('p', {}, 'Couldn’t load stays right now — the free map service is busy.'), h('p', { style: 'margin:10px 0' }, retryBtn('Try again', () => loadStays())), h('p', { class: 'hint' }, 'Or use the booking buttons.')));
  else {
    const pin = trip.pins[blockKey(b)];
    const minT = Math.min(...b.days.map((k) => trip.weather[k]?.min ?? 99));
    let shown = list.filter(STAY_GROUP[v.type]).filter((s) => !v.near || s.dist <= 3000);
    shown.sort((x, y) => (pin?.id === y.id) - (pin?.id === x.id)
      || fitsBudget(y, trip.inputs.budget) - fitsBudget(x, trip.inputs.budget)
      || (!!(y.phone || y.website)) - (!!(x.phone || x.website))
      || x.dist - y.dist);
    if (!shown.length) sl.append(h('div', { class: 'emptylist' }, list.length ? 'No stays match these filters.' : `No stays are listed on OpenStreetMap near ${short(b.place.name)} yet — the booking sites will have more →`));
    const limit = v.more ? 40 : 8;
    shown.slice(0, limit).forEach((s) => sl.append(stayCard(s, b, pin, minT)));
    if (shown.length > limit) sl.append(h('button', { type: 'button', class: 'btn', style: 'grid-column:1/-1', onclick: () => { v.more = true; renderStays(); } }, `Show ${Math.min(40, shown.length) - limit} more`));
  }
  const est = rooms * b.nights * trip.rates.room;
  const book = h('div', { class: 'book' },
    h('h3', {}, '🔎 Check prices & book'),
    h('div', { class: 'q', html: `${esc(short(b.place.name))} · <b>${fmtShort(b.checkin)} → ${fmtShort(b.checkout)}</b> · ${b.nights} night${b.nights > 1 ? 's' : ''}<br>${trip.inputs.people} adult${trip.inputs.people > 1 ? 's' : ''} · ${rooms} room${rooms > 1 ? 's' : ''}` }),
    bookingLinks(b).map(([ic, name, url]) => h('a', { class: 'bk', href: url, target: '_blank', rel: 'noopener' }, `${ic} ${name}`, h('span', {}, '↗'))),
    h('div', { class: 'est' }, h('span', {}, `Stay estimate (${BUDGET[trip.inputs.budget].label})`, h('br'), h('span', { style: 'opacity:.75' }, `${rooms} room${rooms > 1 ? 's' : ''} × ${b.nights} night${b.nights > 1 ? 's' : ''} × ${rupees(trip.rates.room)}`)), h('b', {}, rupees(est))),
    h('div', { class: 'hint' }, 'Listings are free OpenStreetMap data (via Photon). Live prices, photos and reviews open on the booking site.'));
  grid.append(sl, book);
  card.append(grid);
  box.append(card);
}

function stayCard(s, b, pin, minT) {
  const pinned = pin?.id === s.id;
  const badges = [];
  if (fitsBudget(s, trip.inputs.budget)) badges.push(h('span', { class: 'badge' }, `Fits ${BUDGET[trip.inputs.budget].label} budget`));
  if (s.type === 'hostel' || s.type === 'camp_site') badges.push(h('span', { class: 'badge y' }, 'Budget pick'));
  if (s.rooms >= 30) badges.push(h('span', { class: 'badge' }, `${s.rooms} rooms`));
  if (['camp_site', 'alpine_hut'].includes(s.type) && minT <= 5) badges.push(h('span', { class: 'badge r' }, `❄️ ${Math.round(minT)}° — check heating`));
  const acts = h('div', { class: 'acts2' }, h('a', { href: gmaps(s.lat, s.lon, `${s.name} ${short(b.place.name)}`), target: '_blank', rel: 'noopener' }, '🗺️ Map'));
  if (s.website) acts.append(h('a', { href: /^https?:/.test(s.website) ? s.website : 'https://' + s.website, target: '_blank', rel: 'noopener nofollow' }, '🌐 Website'));
  if (s.phone) acts.append(h('a', { href: 'tel:' + s.phone.split(/[;,]/)[0].replace(/[^\d+]/g, '') }, '📞 Call'));
  acts.append(h('a', { href: `https://www.google.com/search?q=${encodeURIComponent(`${s.name} ${short(b.place.name)} reviews`)}`, target: '_blank', rel: 'noopener' }, '🔎 Reviews'));
  acts.append(h('button', { type: 'button', class: 'pin', onclick: () => {
    const k = blockKey(b);
    if (pinned) delete trip.pins[k]; else trip.pins[k] = { id: s.id, name: s.name, lat: s.lat, lon: s.lon };
    persist(); renderStays(); renderDays(); renderMapStays();
    toast(pinned ? 'Unpinned' : `📌 Pinned ${s.name} for ${short(b.place.name)}`);
  } }, pinned ? '✓ Pinned' : '📌 Pin'));
  return h('div', { class: 'stay' + (pinned ? ' pinned' : '') },
    h('div', { class: 't' }, h('div', { class: 'thumb' }, STAY_ICON[s.type] || '🏨'),
      h('div', {}, h('div', { class: 'nm' }, s.name), h('div', { class: 'ty' }, STAY_LABEL[s.type] || 'Stay')),
      s.stars ? h('span', { class: 'stars', 'aria-label': `${s.stars} stars` }, '★'.repeat(Math.round(s.stars)) + '☆'.repeat(Math.max(0, 5 - Math.round(s.stars)))) : null),
    h('div', { class: 'info', html: `<span>📍 <b>${km(s.dist)}</b> from ${esc(short(b.place.name))}</span>${s.area ? `<span>${esc(s.area)}</span>` : ''}` }),
    badges.length ? h('div', { class: 'badges' }, badges) : null,
    acts);
}

/* ---------- costs ---------- */
function renderCosts() {
  const box = $('#costsPanel');
  const r = trip.rates, I = trip.inputs;
  const c = computeCosts({ inputs: { ...I, mileage: r.mileage }, days: trip.days, routeM: trip.route.distance, rates: r });
  trip.costs = c;
  const rows = [
    ['⛽ Fuel', `${num(c.totalKm)} km ÷ ${num(r.mileage, 1)} km/l${c.vehicles > 1 ? ` × ${c.vehicles} vehicles` : ''} = ${num(c.litres, 1)} l × ${rupees(r.fuelPrice)}`, c.fuel, 'var(--orange)'],
    ['🛏 Stay', c.nights ? `${c.rooms} room${c.rooms > 1 ? 's' : ''} × ${c.nights} night${c.nights > 1 ? 's' : ''} × ${rupees(r.room)}` : 'Day trip — no stay', c.stay, '#0f4c4a'],
    ['🍛 Food', `${rupees(r.food)} / person / day × ${I.people} × ${trip.days.length}`, c.food, 'var(--sun)'],
    ['🛂 Tolls', VEHICLES[I.vehicle].toll ? `≈ ${rupees(r.tollPerKm)}/km × ${num(trip.route.distance / 1000)} km${c.vehicles > 1 ? ` × ${c.vehicles}` : ''} (rough)` : 'Two-wheelers don’t pay NH tolls', c.tolls, '#9aa5a6'],
  ];
  if (r.buffer) rows.push(['🧯 Buffer 10%', 'Parking, snacks, surprises', c.buffer, 'var(--red)']);
  const left = h('div', { class: 'card' },
    h('h2', {}, '💰 Cost breakdown'),
    h('div', { class: 'bar' }, rows.map(([, , v, col]) => h('span', { style: `width:${(v / c.total) * 100}%;background:${col}` }))),
    rows.map(([a, s, v, col]) => h('div', { class: 'costrow' }, h('div', {}, h('span', { class: 'sw', style: `background:${col}` }), a, h('small', {}, s)), h('b', {}, rupees(v)))),
    h('div', { class: 'total' }, h('span', { class: 'hint' }, 'Trip total'), h('b', {}, rupees(c.total))),
    h('div', { class: 'pp' }, h('span', {}, `Each of ${I.people} pays`), h('span', {}, rupees(c.perPerson))),
    h('div', { class: 'split' },
      h('div', { class: 'who' }, h('span', {}, '⛽ Fuel per person'), h('b', {}, rupees(c.fuel / I.people))),
      h('div', { class: 'who' }, h('span', {}, '🛏 Stay per person'), h('b', {}, rupees(c.stay / I.people))),
      h('div', { class: 'who' }, h('span', {}, '📅 Per person per day'), h('b', {}, rupees(c.perPerson / trip.days.length)))));

  const field = (label, sub, key, step = 1) => h('label', {}, h('span', {}, label, h('small', {}, sub)),
    h('input', { class: 'inp', type: 'number', min: 0, step, value: r[key], inputmode: 'decimal', oninput: (e) => { const val = parseFloat(e.target.value); if (val >= 0) { r[key] = val; refreshCosts(); } } }));
  const right = h('div', { class: 'card rates' },
    h('h2', {}, '✏️ Adjust the numbers'),
    field('Fuel price', '₹ per litre', 'fuelPrice', 0.5),
    field('Mileage', 'km per litre', 'mileage', 0.5),
    field('Room rate', '₹ per room per night', 'room', 100),
    field('Food', '₹ per person per day', 'food', 50),
    field('Tolls', '₹ per km (rough avg.)', 'tollPerKm', 0.1),
    h('label', { class: 'switch' }, h('span', {}, 'Add 10% buffer', h('small', {}, 'parking, entry tickets, surprises')),
      h('input', { type: 'checkbox', checked: r.buffer, onchange: (e) => { r.buffer = e.target.checked; refreshCosts(); } })),
    h('p', { class: 'hint', style: 'margin-top:8px' }, `Rooms assume 2 people per room. ${c.vehicles} ${VEHICLES[I.vehicle].label.toLowerCase()}${c.vehicles > 1 ? 's' : ''} for ${I.people} (${VEHICLES[I.vehicle].seats} seats each). Local driving adds ~30 km per rest day.`));
  box.innerHTML = '';
  box.append(h('div', { class: 'two' }, left, right));
}
const refreshCosts = debounce(() => {
  const focused = document.activeElement;
  const idx = $$('#costsPanel input').indexOf(focused);
  renderCosts(); renderStats(); persist();
  if (idx >= 0) { const el = $$('#costsPanel input')[idx]; el?.focus(); if (el?.type === 'number') { const v = el.value; el.value = ''; el.value = v; } }
}, 250);

/* ---------- packing ---------- */
function renderPacking() {
  const box = $('#packingPanel');
  const ready = trip.weather.every((w) => w !== undefined);
  const items = [...packingList({ inputs: trip.inputs, days: trip.days, weather: trip.weather.map((w) => w || null), routeM: trip.route.distance }),
    ...trip.custom.map((c) => ({ ...c, cat: 'My items', custom: true }))];
  const done = items.filter((it) => trip.packed[it.id]).length;
  const cats = [...new Set(items.map((i) => i.cat))];
  const card = h('div', { class: 'card' },
    h('div', { class: 'packhead' }, h('h2', { style: 'margin:0' }, '🎒 Packing list'),
      h('div', { class: 'progress' }, h('i', { style: `width:${(done / items.length) * 100}%` })),
      h('span', { class: 'hint' }, `${done} / ${items.length} packed`)),
    ready ? null : h('p', { class: 'hint' }, 'Checking the weather to tailor this list…'),
    h('div', { class: 'packcols' }, cats.map((cat) => h('div', { class: 'packcat' }, h('h4', {}, cat),
      items.filter((i) => i.cat === cat).map((it) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: !!trip.packed[it.id], onchange: (e) => { if (e.target.checked) trip.packed[it.id] = 1; else delete trip.packed[it.id]; persist(); renderPacking(); } }),
        h('span', {}, it.text), it.tag ? h('span', { class: 'tag' }, it.tag) : null,
        it.custom ? h('button', { type: 'button', class: 'del', 'aria-label': 'Remove item', onclick: (e) => { e.preventDefault(); trip.custom = trip.custom.filter((c) => c.id !== it.id); delete trip.packed[it.id]; persist(); renderPacking(); } }, '✕') : null))))),
    h('form', { class: 'addrow', onsubmit: (e) => {
      e.preventDefault(); const inp = e.target.querySelector('input'); const text = inp.value.trim(); if (!text) return;
      trip.custom.push({ id: 'c-' + uid(), text }); persist(); renderPacking(); $('#packingPanel input[name=newitem]')?.focus();
    } }, h('input', { class: 'inp', name: 'newitem', placeholder: 'Add your own item… e.g. Uno cards', 'aria-label': 'Add packing item' }), h('button', { class: 'btn primary', type: 'submit' }, 'Add')));
  box.innerHTML = '';
  box.append(card);
}

/* ---------- fuel ---------- */
function renderFuel() {
  const box = $('#fuelPanel');
  box.innerHTML = '';
  const loading = trip.pois.some((p, i) => p === undefined && trip.days[i].type === 'drive');
  const failed = trip.pois.filter((p, i) => p === null && trip.days[i].type === 'drive').length;
  let all = trip.pois.flatMap((p) => p?.fuel || []).sort((a, b) => a.km - b.km);
  // one per 3 km stretch is enough
  const fuel = []; all.forEach((f) => { if (!fuel.length || f.km - fuel[fuel.length - 1].km > 3) fuel.push(f); });
  const routeKm = trip.route.distance / 1000;
  const r = trip.rates;
  const tank = trip.inputs.vehicle === 'bike' ? 13 : trip.inputs.vehicle === 'hatchback' ? 35 : 50;
  const range = tank * r.mileage;
  const card = h('div', { class: 'card' }, h('h2', {}, '⛽ Fuel stops along the way'));
  if (failed) card.append(h('div', { class: 'note warn', style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px' },
    `Fuel stations for ${failed} driving day${failed > 1 ? 's' : ''} didn’t load.`, retryBtn('Retry', () => retryFailedPois())));
  card.append(h('div', { class: 'facts' },
    h('div', { class: 'fact' }, h('b', {}, `${num(trip.costs?.litres || 0, 0)} l`), 'fuel for the whole trip'),
    h('div', { class: 'fact' }, h('b', {}, `~${num(range)} km`), `range on a full ${tank} l tank`),
    h('div', { class: 'fact' }, h('b', {}, String(fuel.length)), loading ? 'stations found so far…' : 'stations listed near the route')));
  if (!fuel.length) {
    card.append(h('p', { class: 'hint', style: 'margin-top:12px' }, loading ? 'Finding fuel stations along your route…' : 'No fuel stations are listed on this route in OpenStreetMap. Refuel in big towns and keep the tank above half.'));
    box.append(card); return;
  }
  // gaps + suggested refuels
  const pts = [{ km: 0, name: short(trip.inputs.places[0].name), start: true }, ...fuel, { km: routeKm, name: short(trip.waypoints[trip.waypoints.length - 1].name), end: true }];
  let longest = { gap: 0 };
  for (let i = 1; i < pts.length; i++) { const g = pts[i].km - pts[i - 1].km; if (g > longest.gap) longest = { gap: g, a: pts[i - 1], b: pts[i] }; }
  const suggest = new Set(); let fuelLeft = range * 0.9, last = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const nextKm = pts[i + 1].km;
    if (nextKm - last > fuelLeft * 0.75) { suggest.add(pts[i]); last = pts[i].km; }
  }
  if (longest.gap > 60) card.append(h('div', { class: 'note warn', style: 'margin-top:12px' }, `⚠️ Longest gap without a listed station: ${num(longest.gap)} km (${longest.a.name} → ${longest.b.name}). Fill up before it.`));
  const listEl = h('div', { class: 'fuelline' });
  pts.forEach((p, i) => {
    if (i > 0) { const g = p.km - pts[i - 1].km; if (g > 40) listEl.append(h('div', { class: 'fuelrow gap' }, h('span'), h('span', { class: 'dt' }), h('span', {}, `${num(g)} km without a listed station`), h('span'))); }
    const isEnd = p.start || p.end;
    listEl.append(h('div', { class: 'fuelrow' },
      h('span', { class: 'kmk' }, `km ${num(p.km)}`),
      h('span', { class: 'dt', style: isEnd ? 'background:var(--orange)' : suggest.has(p) ? 'background:var(--green)' : '' }),
      h('span', {}, isEnd ? h('b', {}, (p.start ? '🚩 ' : '🏁 ') + p.name) : p.name, suggest.has(p) ? h('span', { class: 'tag', style: 'margin-left:8px' }, 'suggested refuel') : null),
      isEnd ? h('span') : h('a', { href: gmaps(p.lat, p.lon), target: '_blank', rel: 'noopener', class: 'hint' }, 'map ↗')));
  });
  if (fuel.length > 40) card.append(h('p', { class: 'hint', style: 'margin-top:10px' }, `Showing all ${fuel.length} stations. Green = good place to refuel.`));
  card.append(listEl);
  box.append(card);
}

/* ---------- fun ---------- */
function renderFun() {
  const box = $('#funPanel');
  const driveS = trip.days.reduce((s, d) => s + d.driveS, 0);
  const breaks = trip.days.reduce((s, d) => s + (d.breaks || 0), 0);
  const hilly = trip.weather.some((w) => (w?.elevation || 0) > 1200) || trip.weather.some((w) => w && w.min < 5);
  const hot = trip.weather.some((w) => w && w.max > 32);
  const cells = bingoCard({ hilly, hot, seed: trip.bingo.seed });
  const won = bingoWin(trip.bingo.marks);
  const grid = h('div', { class: 'bingo' + (won ? ' win' : '') }, cells.map((c, i) => h('button', {
    type: 'button', class: (i === 5 ? 'free ' : '') + (trip.bingo.marks.includes(i) && i !== 5 ? 'hit' : ''), 'aria-pressed': trip.bingo.marks.includes(i),
    onclick: () => {
      if (i === 5) return;
      const m = trip.bingo.marks; const k = m.indexOf(i);
      k >= 0 ? m.splice(k, 1) : m.push(i);
      const nowWin = bingoWin(m);
      persist(); renderFun();
      if (nowWin && !won) toast('🎉 BINGO! Winner picks the next playlist');
    },
  }, c)));
  const co2 = (trip.costs?.litres || 0) * 2.3;
  box.innerHTML = '';
  box.append(h('div', { class: 'two' },
    h('div', { class: 'card' }, h('h2', {}, '🎲 Road-trip bingo'),
      h('p', { class: 'hint', style: 'margin-bottom:10px' }, 'Tap a square when you spot it. Get 4 in a row to win!'),
      grid,
      h('div', { style: 'display:flex;gap:8px;margin-top:10px' },
        h('button', { type: 'button', class: 'btn sm', id: 'newCard', onclick: () => { trip.bingo = { seed: Math.floor(Math.random() * 1e9), marks: [5] }; persist(); renderFun(); } }, '🔀 New card'),
        won ? h('b', { style: 'color:var(--green);align-self:center' }, '🎉 BINGO!') : null)),
    h('div', { class: 'card' }, h('h2', {}, '🎧 Trip in numbers'),
      h('div', { class: 'playlist' }, '🎵', h('div', {}, 'Music needed for this trip', h('br'), h('b', {}, dur(driveS)), ` ≈ ${num(driveS / 210)} songs`)),
      h('div', { class: 'facts', style: 'margin-top:12px' },
        h('div', { class: 'fact' }, h('b', {}, `☕ ${breaks}`), 'chai breaks planned'),
        h('div', { class: 'fact' }, h('b', {}, `${num(trip.route.distance / 1000 / 40075 * 100, 1)}%`), 'of the way around the Earth'),
        h('div', { class: 'fact' }, h('b', {}, `${num(co2)} kg`), 'CO₂ from fuel (approx.)'),
        h('div', { class: 'fact' }, h('b', {}, `🌳 ${num(Math.max(1, co2 / 21))}`), 'trees for a year to offset it')))));
}

/* ---------- tabs ---------- */
function selectTab(name) {
  $$('#tabs .tab').forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
  $$('.panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
}

/* =====================================================================
   SAVE / SHARE / EXPORT
   ===================================================================== */
function shareCode() {
  const I = trip.inputs;
  return b64urlEncode({
    p: I.places.map((p) => [p.name, p.detail || '', +(+p.lat).toFixed(5), +(+p.lon).toFixed(5)]),
    r: I.roundTrip ? 1 : 0, s: I.start, e: I.end, n: I.people, v: I.vehicle, m: trip.rates.mileage, f: trip.rates.fuelPrice,
    h: I.maxHours, pc: I.pace, b: I.budget, t: trip.title, tm: I.timeMode, ti: I.time, ov: trip.times,
  });
}
function fromShareCode(code) {
  const o = b64urlDecode(code);
  return {
    inputs: {
      places: o.p.map(([name, detail, lat, lon]) => ({ name, detail, lat, lon })), roundTrip: !!o.r, start: o.s, end: o.e,
      people: o.n, vehicle: o.v in VEHICLES ? o.v : 'suv', mileage: o.m, fuelPrice: o.f, maxHours: o.h, pace: o.pc in PACE ? o.pc : 'balanced', budget: o.b in BUDGET ? o.b : 'comfort',
      timeMode: o.tm === 'reach' ? 'reach' : 'leave', time: /^\d\d:\d\d$/.test(o.ti || '') ? o.ti : '07:00',
    },
    title: o.t, times: o.ov && typeof o.ov === 'object' ? o.ov : {},
  };
}

function savedTrips() { return store.get('mm-trips', []); }
function persist() {
  if (!trip) return;
  try { history.replaceState(null, '', location.pathname + '#trip=' + shareCode()); } catch {}
  if (!trip.saved) return;
  const list = savedTrips();
  const rec = { id: trip.id, title: trip.title, inputs: trip.inputs, rates: trip.rates, pins: trip.pins, packed: trip.packed, custom: trip.custom, bingo: trip.bingo, times: trip.times, savedAt: Date.now() };
  const i = list.findIndex((t) => t.id === trip.id);
  if (i >= 0) list[i] = rec; else list.unshift(rec);
  store.set('mm-trips', list.slice(0, 30));
  updateTripCount();
}
function updateTripCount() { const n = savedTrips().length; $('#tripCount').textContent = n ? n : ''; }

function renderTripsList() {
  const box = $('#tripsList');
  const list = savedTrips();
  box.innerHTML = '';
  if (!list.length) { box.append(h('p', { class: 'hint', style: 'padding:10px 0' }, 'No saved trips yet. Plan one and tap “💾 Save trip”.')); return; }
  list.forEach((t) => box.append(h('div', { class: 'tripitem' },
    h('div', {}, h('b', {}, t.title), h('small', {}, `${fmtRange(parseDate(t.inputs.start), parseDate(t.inputs.end))} · ${t.inputs.people} people · ${t.inputs.places.map((p) => short(p.name)).join(' → ')}`)),
    h('button', { class: 'btn sm', onclick: () => { $('#tripsDlg').close(); loadInputsToForm(t.inputs); plan(JSON.parse(JSON.stringify(t.inputs)), t); } }, 'Open'),
    h('button', { class: 'btn sm', 'aria-label': 'Delete trip', onclick: () => {
      if (!confirm(`Delete “${t.title}”?`)) return;
      store.set('mm-trips', savedTrips().filter((x) => x.id !== t.id));
      if (trip?.id === t.id) { trip.saved = false; $('#saveBtn').textContent = '💾 Save trip'; }
      renderTripsList(); updateTripCount();
    } }, '🗑'))));
}

function loadInputsToForm(I) {
  Object.assign(form, JSON.parse(JSON.stringify(I)), { mileageEdited: true });
  renderPlaces(); syncForm();
}

function ics() {
  const esc2 = (s) => String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ymd = (d) => isoDate(d).replace(/-/g, '');
  const ymdhm = (d) => `${ymd(d)}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MileMates//Road Trip Planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc2(trip.title)}`];
  trip.days.forEach((d, i) => {
    const wx = trip.weather[i];
    const sum = d.type === 'drive' ? `Day ${i + 1}: ${short(d.from.name)} → ${short(d.to.name)} (${km(d.distM)}, ${dur(d.driveS)})` : `Day ${i + 1}: Explore ${short(d.to.name)}`;
    const tt = d.type === 'drive' ? dayTimes(d, timingFor(i).mode, timingFor(i).time) : null;
    const desc = [
      trip.title,
      d.type === 'drive' ? `Drive ${km(d.distM)} · ${dur(d.driveS)} · ${d.breaks} breaks` : 'Rest / explore day',
      tt ? `Leave ${short(d.from.name)} ${clock(tt.depart)} → reach ${short(d.to.name)} ${clock(tt.arrive)}` : '',
      wx ? `Weather: ${WMO(wx.code)[1]}, ${Math.round(wx.max)}°/${Math.round(wx.min)}°` : '',
      d.final ? 'Trip ends' : `Night halt: ${short(d.to.name)}`,
      d.type === 'drive' ? `Navigate: ${navLink(d)}` : '',
    ].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:${trip.id}-${i}@milemates`, `DTSTAMP:${stamp}`, ...(tt ? [`DTSTART:${ymdhm(tt.depart)}`, `DTEND:${ymdhm(tt.arrive)}`] : [`DTSTART;VALUE=DATE:${ymd(d.date)}`, `DTEND;VALUE=DATE:${ymd(addDays(d.date, 1))}`]),
      `SUMMARY:${esc2(sum)}`, `DESCRIPTION:${esc2(desc)}`, `LOCATION:${esc2(short(d.to.name))}`, 'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  const fold = (l) => l.length <= 74 ? l : l.match(/.{1,73}/g).join('\r\n ');
  const blob = new Blob([lines.map(fold).join('\r\n')], { type: 'text/calendar' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${trip.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'road-trip'}.ics` });
  document.body.append(a); a.click(); a.remove();
  toast('📅 Calendar file downloaded — open it to add the days');
}

function bindResults() {
  $$('#tabs .tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  $('#shareBtn').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#trip=${shareCode()}`;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: trip.title, text: `Our road trip plan: ${trip.title}`, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('🔗 Link copied — send it to your group!'); }
    catch { prompt('Copy this link:', url); }
  });
  $('#icsBtn').addEventListener('click', ics);
  $('#printBtn').addEventListener('click', () => { map?.invalidateSize(); setTimeout(() => window.print(), 100); });
  $('#saveBtn').addEventListener('click', () => {
    if (trip.saved) { toast('Already saved — changes save automatically'); return; }
    trip.saved = true; persist();
    $('#saveBtn').textContent = '✓ Saved'; $('#readyNote').textContent = 'Saved trip 💾';
    toast('💾 Saved in this browser. Find it under “My trips”.');
  });
  $('#tripTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  $('#tripTitle').addEventListener('blur', (e) => {
    const t = e.target.textContent.trim();
    if (t) { trip.title = t; persist(); history.replaceState(null, '', location.pathname + '#trip=' + shareCode()); } else e.target.textContent = trip.title;
  });
  $('#retryBtn').addEventListener('click', () => (lastInputs ? plan(lastInputs) : submit()));
}

/* =====================================================================
   CHROME: theme, dialogs, examples, PWA
   ===================================================================== */
function bindChrome() {
  const setIcon = () => {
    const t = document.documentElement.dataset.theme;
    const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    $('#themeBtn').textContent = dark ? '☀️' : '🌙';
  };
  $('#themeBtn').addEventListener('click', () => {
    const t = document.documentElement.dataset.theme;
    const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('mm-theme', document.documentElement.dataset.theme); } catch {}
    setIcon();
  });
  setIcon();
  $('#navPlan').addEventListener('click', () => { $('#formCard').scrollIntoView({ behavior: 'smooth' }); $$('#places .inp')[0]?.focus(); });
  $('#navTrips').addEventListener('click', () => { renderTripsList(); $('#tripsDlg').showModal(); });
  $('#navHow').addEventListener('click', () => $('#howDlg').showModal());
  $$('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  });

  const EX = [
    { t: 'Delhi → Manali', s: 'Mountains · 4–5 days', places: [{ name: 'New Delhi', detail: 'Delhi, India', lat: 28.6139, lon: 77.209 }, { name: 'Manali', detail: 'Himachal Pradesh, India', lat: 32.2396, lon: 77.1887 }], nights: 4 },
    { t: 'Mumbai → Goa', s: 'Coastal · 5 days', places: [{ name: 'Mumbai', detail: 'Maharashtra, India', lat: 19.076, lon: 72.8777 }, { name: 'Panaji', detail: 'Goa, India', lat: 15.4909, lon: 73.8278 }], nights: 4 },
    { t: 'Bengaluru → Coorg', s: 'Weekend · 3 days', places: [{ name: 'Bengaluru', detail: 'Karnataka, India', lat: 12.9716, lon: 77.5946 }, { name: 'Madikeri', detail: 'Karnataka, India', lat: 12.4244, lon: 75.7382 }], nights: 2 },
    { t: 'Jaipur → Jaisalmer', s: 'Desert · 5 days', places: [{ name: 'Jaipur', detail: 'Rajasthan, India', lat: 26.9124, lon: 75.7873 }, { name: 'Jodhpur', detail: 'Rajasthan, India', lat: 26.2389, lon: 73.0243 }, { name: 'Jaisalmer', detail: 'Rajasthan, India', lat: 26.9157, lon: 70.9083 }], nights: 4 },
  ];
  $('#examples').append(...EX.map((e) => h('button', { class: 'example', type: 'button', onclick: () => {
    form.places = JSON.parse(JSON.stringify(e.places));
    form.start = isoDate(addDays(today, 14)); form.end = isoDate(addDays(today, 14 + e.nights));
    renderPlaces(); syncForm(); submit();
  } }, h('b', {}, e.t), h('small', {}, e.s))));

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* =====================================================================
   BOOT
   ===================================================================== */
function boot() {
  bindForm(); bindResults(); bindChrome();
  renderPlaces(); syncForm(); updateTripCount();
  const m = location.hash.match(/trip=([\w-]+)/);
  if (m) {
    try {
      const { inputs, title, times } = fromShareCode(m[1]);
      loadInputsToForm(inputs);
      plan(JSON.parse(JSON.stringify(inputs)), { title, times });
    } catch (e) { console.warn('bad share link', e); toast('That trip link looks broken — plan a new one!'); }
  }
}
boot();
