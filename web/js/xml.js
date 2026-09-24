// Tolerant XML reader matching the original engine's hand-written parser.
// The game's XML is not always well formed (e.g. '<<title>>' inside attribute
// values, raw newlines inside attributes), so the browser DOMParser is unusable.
// Attribute values are kept raw; comments are kept as {comment: text} children
// because bitmap fonts use "<!-- row N -->" markers to split glyph rows.

export class XNode {
  constructor(tag, attrs) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = [];
  }
  attr(name, def) {
    const v = this.attrs[name];
    if (v !== undefined) return v;
    // attribute names are matched case-insensitively as a fallback
    const lower = name.toLowerCase();
    for (const k in this.attrs) if (k.toLowerCase() === lower) return this.attrs[k];
    return def;
  }
  num(name, def = 0) {
    const v = this.attr(name);
    if (v === undefined || v === '') return def;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : def;
  }
  bool(name, def = false) {
    const v = this.attr(name);
    if (v === undefined) return def;
    return /^(1|true|yes)$/i.test(v.trim());
  }
  elements(tag) {
    const out = [];
    for (const c of this.children) if (c.tag && (!tag || c.tag.toLowerCase() === tag.toLowerCase())) out.push(c);
    return out;
  }
  first(tag) {
    for (const c of this.children) if (c.tag && c.tag.toLowerCase() === tag.toLowerCase()) return c;
    return null;
  }
}

export function parseXML(text) {
  const root = new XNode('#document', {});
  const stack = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      const body = text.slice(lt + 4, end < 0 ? n : end);
      stack[stack.length - 1].children.push({ comment: body });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      const name = text.slice(lt + 2, end).trim().toLowerCase();
      // pop to the matching element (tolerate mismatches)
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag.toLowerCase() === name) { stack.length = s; break; }
      }
      i = end < 0 ? n : end + 1;
      continue;
    }
    // start tag
    let p = lt + 1;
    const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(text.slice(p, p + 64));
    if (!nameMatch) { i = lt + 1; continue; }
    const tag = nameMatch[0];
    p += tag.length;
    const attrs = {};
    let selfClose = false;
    while (p < n) {
      while (p < n && /\s/.test(text[p])) p++;
      if (text[p] === '/' && text[p + 1] === '>') { selfClose = true; p += 2; break; }
      if (text[p] === '>') { p++; break; }
      const an = /^[\w:.-]+/.exec(text.slice(p, p + 128));
      if (!an) { p++; continue; }
      p += an[0].length;
      while (p < n && /\s/.test(text[p])) p++;
      if (text[p] !== '=') { attrs[an[0]] = ''; continue; }
      p++;
      while (p < n && /\s/.test(text[p])) p++;
      const q = text[p];
      if (q === '"' || q === "'") {
        const end = text.indexOf(q, p + 1);
        attrs[an[0]] = text.slice(p + 1, end < 0 ? n : end);
        p = end < 0 ? n : end + 1;
      } else {
        const m = /^[^\s>]+/.exec(text.slice(p));
        attrs[an[0]] = m ? m[0] : '';
        p += m ? m[0].length : 0;
      }
    }
    const node = new XNode(tag, attrs);
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = p;
  }
  return root.elements()[0] || root;
}

// Text attributes use literal "\n" for line breaks, and are often wrapped over
// several physical lines with indentation that is not meant to be displayed.
export function decodeText(s) {
  if (s == null) return '';
  return s.replace(/\r?\n[ \t]*/g, '').replace(/\\n/g, '\n').replace(/\t/g, ' ');
}
