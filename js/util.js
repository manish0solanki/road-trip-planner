// Small shared helpers: formatting, geometry, caching fetch, DOM.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- formatting (India: ₹, km, en-IN digit grouping) ----------
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const rupees = (n) => inr.format(Math.round(n || 0));
export const num = (n, d = 0) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: 0 });
export const km = (m) => `${num(m / 1000, m < 10000 ? 1 : 0)} km`;

export function dur(sec) {
  const mins = Math.round(sec / 60);
  const hh = Math.floor(mins / 60), mm = mins % 60;
  if (!hh) return `${mm} m`;
  return `${hh} h ${String(mm).padStart(2, '0')} m`;
}

export function clock(date) {
  return date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', ' ');
}

export const isoDate = (d) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};
export const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const fmtDay = (d) => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtShort = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
export const fmtRange = (a, b) =>
  `${a.getDate()}${a.getMonth() !== b.getMonth() ? ' ' + a.toLocaleDateString('en-IN', { month: 'short' }) : ''} – ${b.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;

// ---------- geometry ----------
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
export function haversine(a, b) {
  // a, b: [lat, lon]
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function cumulative(coords) {
  const out = [0];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + haversine(coords[i - 1], coords[i]));
  return out;
}

// Ramer–Douglas–Peucker on [lat, lon] (planar approx, fine for display/queries).
export function simplify(coords, tolDeg) {
  if (coords.length <= 2) return coords.slice();
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ay, ax] = coords[s], [by, bx] = coords[e];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
    let best = -1, bestD = tolDeg * tolDeg;
    for (let i = s + 1; i < e; i++) {
      const [py, px] = coords[i];
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + t * dx - px, qy = ay + t * dy - py;
      const d = qx * qx + qy * qy;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([s, best], [best, e]); }
  }
  return coords.filter((_, i) => keep[i]);
}

// Reduce to at most n points (simplify progressively).
export function simplifyTo(coords, n) {
  let tol = 0.002, out = coords;
  while (out.length > n && tol < 5) { out = simplify(coords, tol); tol *= 1.8; }
  return out;
}

export function nearestIndex(coords, p) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const dy = coords[i][0] - p[0], dx = (coords[i][1] - p[1]) * Math.cos(rad(p[0]));
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// ---------- fetch with cache + polite queue ----------
const memo = new Map();
const LS_PREFIX = 'mm-cache:';
const TTL = 1000 * 60 * 60 * 6; // 6 h

function lsGet(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (Date.now() - t > TTL) { localStorage.removeItem(LS_PREFIX + key); return null; }
    return v;
  } catch { return null; }
}
function lsSet(key, v) {
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify({ t: Date.now(), v })); }
  catch {
    // storage full: clear our cache entries and move on
    try { Object.keys(localStorage).filter((k) => k.startsWith(LS_PREFIX)).forEach((k) => localStorage.removeItem(k)); } catch {}
  }
}

const queues = new Map(); // host -> promise chain (one request at a time per host)
const lastHit = new Map();

export async function getJSON(url, { cache = true, persist = false, minGap = 0, signal, body, timeout = 30000 } = {}) {
  const key = url + (body ? '|' + body : '');
  if (cache && memo.has(key)) return memo.get(key);
  if (persist) { const v = lsGet(key); if (v) { memo.set(key, v); return v; } }

  const host = new URL(url).host;
  const run = async () => {
    if (minGap) {
      const wait = (lastHit.get(host) || 0) + minGap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    lastHit.set(host, Date.now());
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    if (signal) signal.addEventListener('abort', () => ctrl.abort());
    try {
      const res = await fetch(url, body
        ? { method: 'POST', body, signal: ctrl.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        : { signal: ctrl.signal });
      if (!res.ok) throw new Error(`${host} answered ${res.status}`);
      return await res.json();
    } finally { clearTimeout(t); }
  };

  let p;
  if (minGap) {
    const prev = queues.get(host) || Promise.resolve();
    p = prev.catch(() => {}).then(run);
    queues.set(host, p);
  } else p = run();

  const v = await p;
  if (cache) memo.set(key, v);
  if (persist) lsSet(key, v);
  return v;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function shuffle(arr, seed = Math.random() * 1e9) {
  const a = arr.slice();
  let s = Math.floor(seed) || 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export function b64urlEncode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = ''; bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

export function toast(msg, ms = 2600) {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}
