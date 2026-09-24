// Bitmap fonts: <font face image height ascent gap spaceWidth> with
// <glyph char a b c> ABC widths. Glyphs are packed left to right starting at
// x = gap, stepping b + gap; rows start at y = gap and step height + gap. A row
// break happens on a "<!-- row N -->" comment or when a glyph would overflow.
import { assets } from './assets.js';
import { normPath } from './util.js';

const cache = new Map();

export class BitmapFont {
  constructor(xmlPath) {
    const doc = assets.xml(xmlPath);
    this.ok = !!doc;
    this.glyphs = new Map();
    if (!doc) { this.height = 16; this.ascent = 12; return; }
    this.height = doc.num('height', 16);
    this.ascent = doc.num('ascent', this.height);
    this.gap = doc.num('gap', 2);
    this.image = assets.image(doc.attr('image'));
    const imgW = this.image ? this.image.w : 1024;
    let x = this.gap, y = this.gap, rowStarted = false;
    for (const c of doc.children) {
      if (c.comment !== undefined) {
        if (/row/i.test(c.comment) && rowStarted) { x = this.gap; y += this.height + this.gap; rowStarted = false; }
        continue;
      }
      if (!c.tag || c.tag.toLowerCase() !== 'glyph') continue;
      const code = c.num('char');
      const a = c.num('a'), b = c.num('b'), cc = c.num('c');
      if (x + b > imgW && rowStarted) { x = this.gap; y += this.height + this.gap; }
      this.glyphs.set(code, { sx: x, sy: y, w: b, a, c: cc });
      x += b + this.gap;
      rowStarted = true;
    }
    const sp = this.glyphs.get(32);
    this.spaceAdvance = sp ? sp.a + sp.w + sp.c : Math.max(doc.num('spaceWidth', 0), Math.round(this.height * 0.3));
  }

  static get(path) {
    const k = normPath(path);
    if (!cache.has(k)) cache.set(k, new BitmapFont(k));
    return cache.get(k);
  }

  glyph(ch) {
    const code = ch.charCodeAt(0);
    return this.glyphs.get(code) || this.glyphs.get(ch.toUpperCase().charCodeAt(0)) || this.glyphs.get(ch.toLowerCase().charCodeAt(0));
  }

  lineWidth(line) {
    let w = 0;
    for (const ch of line) {
      if (ch === ' ') { w += this.spaceAdvance; continue; }
      const g = this.glyph(ch);
      if (g) w += g.a + g.w + g.c;
    }
    return w;
  }

  measure(text) {
    const lines = String(text).split('\n');
    return { w: Math.max(0, ...lines.map(l => this.lineWidth(l))), h: lines.length * this.height, lines };
  }

  // Draws text with its top-left at (x, y) (xAlign handled per line).
  draw(ctx, text, x, y, align = 'left', img = null, maxChars = Infinity) {
    const src = img || this.image;
    if (!src) return;
    const lines = String(text).split('\n');
    let drawn = 0;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const lw = this.lineWidth(line);
      let cx = align === 'center' ? x - lw / 2 : align === 'right' ? x - lw : x;
      const cy = y + li * this.height;
      for (const ch of line) {
        if (drawn++ >= maxChars) return;
        if (ch === ' ') { cx += this.spaceAdvance; continue; }
        const g = this.glyph(ch);
        if (!g) continue;
        cx += g.a;
        if (g.w > 0) ctx.drawImage(src.img, g.sx, g.sy, g.w, this.height, cx, cy, g.w, this.height);
        cx += g.w + g.c;
      }
    }
  }
}
