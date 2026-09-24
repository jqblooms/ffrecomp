// Small helpers shared across the engine.

export const VIEW_W = 640;
export const VIEW_H = 480;

export function rand(a, b) { return a + Math.random() * (b - a); }
export function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }

// "(a,b)" -> {min,max}; "5" -> {min:5,max:5}. The original stores these as ranges
// and samples them when a fish is spawned or a timer is re-armed.
export function parseRange(v, def = 0) {
  if (v === undefined || v === null || v === '') return { min: def, max: def };
  if (typeof v === 'number') return { min: v, max: v };
  const s = String(v).replace(/[()\sf]/g, '');
  const parts = s.split(',').map(parseFloat);
  if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
    return { min: Math.min(parts[0], parts[1]), max: Math.max(parts[0], parts[1]), a: parts[0], b: parts[1] };
  }
  const x = parseFloat(s);
  return Number.isFinite(x) ? { min: x, max: x } : { min: def, max: def };
}
export function sample(r) { return r.min === r.max ? r.min : rand(r.min, r.max); }

export function parseVec(v, def = [0, 0]) {
  if (!v) return def.slice();
  const p = String(v).split(',').map(s => parseFloat(s));
  return p.map((x, i) => (Number.isFinite(x) ? x : def[i] || 0));
}

// "m:ss" -> seconds
export function parseTime(s) {
  if (!s) return 0;
  const [m, sec] = String(s).split(':').map(Number);
  return sec === undefined ? m : m * 60 + sec;
}

export function fmtTime(t) {
  t = Math.max(0, Math.ceil(t));
  const m = Math.floor(t / 60), s = t % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

export function fmtScore(n) {
  return Math.floor(n).toLocaleString('en-US');
}

export function rectsOverlap(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Normalise a resource path as written in the game's XML (mixed case, back
// slashes) to the lower-case key used by the asset manifest.
export function normPath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').toLowerCase();
}

export const storage = {
  get(key, def) {
    try {
      const v = localStorage.getItem('ffweb.' + key);
      return v === null ? def : JSON.parse(v);
    } catch { return def; }
  },
  set(key, value) {
    try { localStorage.setItem('ffweb.' + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};
