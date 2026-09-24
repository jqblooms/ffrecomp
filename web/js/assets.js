// Asset manager: resolves the game's resource paths against the manifest built by
// tools/extract_assets.py, preloads images, and produces hue/saturation/value
// shifted variants (the original generated these on load as
// "%s_H_%d_S_%d_V_%d" images for fish that declare hsvOffset).
import { parseXML } from './xml.js';
import { normPath } from './util.js';

const BASE = 'game/';

class Assets {
  constructor() {
    this.manifest = null;
    this.images = new Map(); // key -> {img, w, h}
    this.xmlCache = new Map();
    this.frameCache = new Map();
    this.hsvCache = new Map();
    this.byNoExt = new Map(); // key without extension -> key
  }

  async loadManifest() {
    const res = await fetch(BASE + 'manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('manifest.json missing (' + res.status + ')');
    this.manifest = await res.json();
    for (const k of Object.keys(this.manifest.images)) {
      this.byNoExt.set(k.replace(/\.(jpg|png)$/, ''), k);
    }
  }

  async preloadImages(onProgress) {
    const keys = Object.keys(this.manifest.images);
    let done = 0;
    const load = (key) => new Promise((resolve) => {
      const [file, w, h] = this.manifest.images[key];
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { this.images.set(key, { img, w, h, key }); done++; onProgress && onProgress(done / keys.length); resolve(); };
      img.onerror = () => { done++; onProgress && onProgress(done / keys.length); resolve(); };
      img.src = BASE + file;
    });
    // bounded parallelism keeps mobile browsers responsive
    const queue = keys.slice();
    const workers = Array.from({ length: 8 }, async () => {
      while (queue.length) await load(queue.shift());
    });
    await Promise.all(workers);
  }

  resolveImageKey(path) {
    let k = normPath(path);
    if (!k) return null;
    if (k.startsWith('_') || k.includes('/_')) {
      // alpha planes were merged into their colour image
      k = k.replace(/(^|\/)_([^/]+)$/, '$1$2');
    }
    if (this.manifest.images[k]) return k;
    const noExt = k.replace(/\.(jpg|png|bmp|tga)$/, '');
    if (this.byNoExt.has(noExt)) return this.byNoExt.get(noExt);
    for (const suffix of ['0', '1', '.1']) {
      if (this.byNoExt.has(noExt + suffix)) return this.byNoExt.get(noExt + suffix);
    }
    return null;
  }

  image(path) {
    const k = this.resolveImageKey(path);
    return k ? this.images.get(k) || null : null;
  }

  // All numbered frames for a prefix: "resources/angelfish/swim/swim_cycle." ->
  // swim_cycle.1 .. swim_cycle.N ; "resources/fx/bubbleparticle" -> bubbleparticle0..N
  frames(prefix) {
    const p = normPath(prefix);
    if (this.frameCache.has(p)) return this.frameCache.get(p);
    const byIndex = new Map();
    for (const k of Object.keys(this.manifest.images)) {
      if (!k.startsWith(p)) continue;
      const rest = k.slice(p.length);
      const m = /^(\d+)\.(jpg|png)$/.exec(rest);
      if (!m) continue;
      const i = parseInt(m[1], 10);
      // a .jpg entry already carries the merged alpha plane; prefer it
      if (!byIndex.has(i) || m[2] === 'jpg') byIndex.set(i, k);
    }
    const found = [...byIndex.entries()].sort((a, b) => a[0] - b[0]);
    let out = found.map(([, k]) => this.images.get(k)).filter(Boolean);
    if (!out.length) {
      const single = this.image(prefix);
      if (single) out = [single];
    }
    this.frameCache.set(p, out);
    return out;
  }

  xml(path) {
    const k = normPath(path);
    if (this.xmlCache.has(k)) return this.xmlCache.get(k);
    const text = this.manifest.xml[k];
    if (text === undefined) { this.xmlCache.set(k, null); return null; }
    const doc = parseXML(text);
    this.xmlCache.set(k, doc);
    return doc;
  }

  // Hue in degrees, saturation / value as additive offsets (-1..1), mirroring
  // the hsvOffset attribute. Returns a canvas-backed image entry.
  hsv(entry, h, s, v) {
    if (!entry || (!h && !s && !v)) return entry;
    const key = entry.key + '|' + h + '|' + s + '|' + v;
    let out = this.hsvCache.get(key);
    if (out) return out;
    const c = document.createElement('canvas');
    c.width = entry.w; c.height = entry.h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(entry.img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      let r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255;
      const max = Math.max(r, gg, b), min = Math.min(r, gg, b), dd = max - min;
      let hh = 0;
      if (dd) {
        if (max === r) hh = ((gg - b) / dd) % 6;
        else if (max === gg) hh = (b - r) / dd + 2;
        else hh = (r - gg) / dd + 4;
        hh *= 60;
      }
      let ss = max ? dd / max : 0, vv = max;
      hh = (hh + h + 360) % 360;
      ss = Math.min(1, Math.max(0, ss + s));
      vv = Math.min(1, Math.max(0, vv + v));
      const C = vv * ss, X = C * (1 - Math.abs(((hh / 60) % 2) - 1)), m = vv - C;
      let rr, g2, bb;
      if (hh < 60) [rr, g2, bb] = [C, X, 0];
      else if (hh < 120) [rr, g2, bb] = [X, C, 0];
      else if (hh < 180) [rr, g2, bb] = [0, C, X];
      else if (hh < 240) [rr, g2, bb] = [0, X, C];
      else if (hh < 300) [rr, g2, bb] = [X, 0, C];
      else [rr, g2, bb] = [C, 0, X];
      px[i] = (rr + m) * 255; px[i + 1] = (g2 + m) * 255; px[i + 2] = (bb + m) * 255;
    }
    g.putImageData(d, 0, 0);
    out = { img: c, w: entry.w, h: entry.h, key };
    this.hsvCache.set(key, out);
    return out;
  }

  // Colour-offset tint used by text buttons (upAddColor / overAddColor).
  tinted(entry, add) {
    if (!entry || !add || (!add[0] && !add[1] && !add[2])) return entry;
    const key = entry.key + '|add|' + add.join(',');
    let out = this.hsvCache.get(key);
    if (out) return out;
    const c = document.createElement('canvas');
    c.width = entry.w; c.height = entry.h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(entry.img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      px[i] = Math.max(0, Math.min(255, px[i] + add[0] * 255));
      px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + add[1] * 255));
      px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + add[2] * 255));
    }
    g.putImageData(d, 0, 0);
    out = { img: c, w: entry.w, h: entry.h, key };
    this.hsvCache.set(key, out);
    return out;
  }

  soundUrl(path) {
    const k = normPath(path);
    const f = this.manifest.sounds[k];
    return f ? BASE + f : null;
  }
}

export const assets = new Assets();
