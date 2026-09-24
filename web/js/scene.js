// Screen layouts: the XML <screen> documents in config/ describe menus, HUD and
// pop-ups as a tree of group / image / text / imageButton / textButton /
// checkBox / particleSystem nodes (the original engine's ScreenLayout).
import { assets } from './assets.js';
import { audio } from './audio.js';
import { BitmapFont } from './font.js';
import { ParticleSystem } from './particles.js';
import { parseVec } from './util.js';
import { decodeText } from './xml.js';

export class Node {
  constructor(x = 0, y = 0) {
    this.name = '';
    this.x = x; this.y = y;
    this.sx = 1; this.sy = 1;
    this.opacity = 1;
    this.visible = true;
    this.children = [];
    this.parent = null;
  }
  add(child) { child.parent = this; this.children.push(child); return child; }
  remove(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
  }
  find(name) {
    if (this.name === name) return this;
    for (const c of this.children) {
      const f = c.find(name);
      if (f) return f;
    }
    return null;
  }
  findAll(pred, out = []) {
    if (pred(this)) out.push(this);
    for (const c of this.children) c.findAll(pred, out);
    return out;
  }
  update(dt) { for (const c of this.children) c.update(dt); }
  draw(ctx) {
    if (!this.visible || this.opacity <= 0) return;
    ctx.save();
    ctx.translate(this.x, this.y);
    if (this.sx !== 1 || this.sy !== 1) ctx.scale(this.sx, this.sy);
    ctx.globalAlpha *= Math.min(1, this.opacity);
    this.drawSelf(ctx);
    for (const c of this.children) c.draw(ctx);
    ctx.restore();
  }
  drawSelf() {}
  // absolute transform (translation + scale only)
  worldTransform() {
    let x = 0, y = 0, sx = 1, sy = 1;
    const chain = [];
    for (let n = this; n; n = n.parent) chain.unshift(n);
    for (const n of chain) {
      x += n.x * sx; y += n.y * sy;
      sx *= n.sx; sy *= n.sy;
    }
    return { x, y, sx, sy };
  }
  isShown() {
    for (let n = this; n; n = n.parent) if (!n.visible) return false;
    return true;
  }
}

export class ImageNode extends Node {
  constructor(file, x, y, pivot) {
    super(x, y);
    this.setImage(file);
    this.center = pivot === 'center';
  }
  setImage(file) { this.image = typeof file === 'string' ? assets.image(file) : file; }
  get w() { return this.image ? this.image.w : 0; }
  get h() { return this.image ? this.image.h : 0; }
  drawSelf(ctx) {
    if (!this.image) return;
    const ox = this.center ? -this.image.w / 2 : 0, oy = this.center ? -this.image.h / 2 : 0;
    ctx.drawImage(this.image.img, ox, oy);
  }
}

export class TextNode extends Node {
  constructor(font, text, x, y, xAlign = 'left', yAlign = 'top') {
    super(x, y);
    this.font = typeof font === 'string' ? BitmapFont.get(font) : font;
    this.text = text;
    this.xAlign = xAlign;
    this.yAlign = yAlign;
    this.image = null; // optional tinted atlas
    this.maxChars = Infinity;
  }
  bounds() {
    const m = this.font.measure(this.text);
    let x = this.xAlign === 'center' ? -m.w / 2 : this.xAlign === 'right' ? -m.w : 0;
    let y = this.yAlign === 'middle' || this.yAlign === 'center' ? -m.h / 2 : this.yAlign === 'bottom' ? -m.h : 0;
    return { x, y, w: m.w, h: m.h };
  }
  drawSelf(ctx) {
    if (!this.text) return;
    const b = this.bounds();
    this.font.draw(ctx, this.text, this.xAlign === 'left' ? 0 : this.xAlign === 'center' ? 0 : 0, b.y, this.xAlign, this.image, this.maxChars);
  }
}

class Button extends Node {
  constructor(node) {
    super(node.num('x'), node.num('y'));
    this.action = node.attr('action') || node.attr('defaultAction');
    this.overSound = node.attr('overSound');
    this.activeSound = node.attr('activeSound');
    this.hover = false;
    this.pressed = false;
    this.enabled = true;
  }
  localBounds() { return { x: 0, y: 0, w: 0, h: 0 }; }
  hit(px, py) {
    if (!this.enabled || !this.isShown()) return false;
    const t = this.worldTransform();
    const b = this.localBounds();
    let x1 = t.x + b.x * t.sx, x2 = t.x + (b.x + b.w) * t.sx;
    let y1 = t.y + b.y * t.sy, y2 = t.y + (b.y + b.h) * t.sy;
    if (x1 > x2) [x1, x2] = [x2, x1];
    if (y1 > y2) [y1, y2] = [y2, y1];
    const pad = 4;
    return px >= x1 - pad && px <= x2 + pad && py >= y1 - pad && py <= y2 + pad;
  }
}

export class ImageButton extends Button {
  constructor(node) {
    super(node);
    this.up = assets.image(node.attr('upImg'));
    this.over = assets.image(node.attr('overImg')) || this.up;
    this.active = assets.image(node.attr('activeImg')) || this.over;
    this.center = node.attr('pivot') === 'center';
  }
  localBounds() {
    const i = this.up || this.over;
    if (!i) return { x: 0, y: 0, w: 0, h: 0 };
    return this.center ? { x: -i.w / 2, y: -i.h / 2, w: i.w, h: i.h } : { x: 0, y: 0, w: i.w, h: i.h };
  }
  drawSelf(ctx) {
    const i = this.pressed ? this.active : this.hover ? this.over : this.up;
    if (!i) return;
    const b = this.localBounds();
    ctx.drawImage(i.img, b.x, b.y);
  }
}

export class TextButton extends Button {
  constructor(node) {
    super(node);
    this.text = decodeText(node.attr('string', ''));
    this.xAlign = node.attr('xAlign', 'left');
    const f = node.attr('font');
    this.fonts = {
      up: BitmapFont.get(f),
      over: BitmapFont.get(node.attr('overFont') || f),
      active: BitmapFont.get(node.attr('activeFont') || node.attr('overFont') || f),
    };
    const col = (a) => (a ? parseVec(a, [0, 0, 0]) : null);
    this.colors = { up: col(node.attr('upAddColor')), over: col(node.attr('overAddColor')), active: col(node.attr('activeAddColor')) };
  }
  localBounds() {
    const m = this.fonts.up.measure(this.text);
    const x = this.xAlign === 'center' ? -m.w / 2 : this.xAlign === 'right' ? -m.w : 0;
    return { x, y: 0, w: m.w, h: m.h };
  }
  drawSelf(ctx) {
    const st = this.pressed ? 'active' : this.hover ? 'over' : 'up';
    const font = this.fonts[st];
    const img = assets.tinted(font.image, this.colors[st]);
    font.draw(ctx, this.text, 0, 0, this.xAlign, img);
  }
}

export class CheckBox extends Button {
  constructor(node) {
    super(node);
    this.imgs = {
      off: assets.image(node.attr('uncheckedImg')),
      on: assets.image(node.attr('checkedImg')),
      offOver: assets.image(node.attr('uncheckedOverImg')),
      onOver: assets.image(node.attr('checkedOverImg')),
    };
    this.checked = false;
  }
  localBounds() {
    const i = this.imgs.off || this.imgs.on;
    return i ? { x: 0, y: 0, w: i.w, h: i.h } : { x: 0, y: 0, w: 0, h: 0 };
  }
  drawSelf(ctx) {
    const i = this.checked ? (this.hover ? this.imgs.onOver : this.imgs.on) : (this.hover ? this.imgs.offOver : this.imgs.off);
    if (i) ctx.drawImage(i.img, 0, 0);
  }
}

export class ParticleNode extends Node {
  constructor(file, x, y, autoStop) {
    super(x, y);
    this.system = new ParticleSystem(file, 0, 0, { autoStop, warmup: 4 });
  }
  update(dt) { this.system.update(dt); super.update(dt); }
  drawSelf(ctx) { this.system.draw(ctx); }
}

function applyCommon(n, node) {
  n.name = node.attr('name', '');
  n.sx = node.num('scaleX', 1);
  n.sy = node.num('scaleY', 1);
  n.opacity = node.num('opacity', 1);
  if (node.attr('visible') !== undefined) n.visible = node.bool('visible', true);
  return n;
}

function build(node, parent, subs) {
  const tag = node.tag.toLowerCase();
  let n = null;
  switch (tag) {
    case 'group':
      n = applyCommon(new Node(node.num('x'), node.num('y')), node);
      for (const c of node.elements()) build(c, n, subs);
      break;
    case 'image':
      n = applyCommon(new ImageNode(node.attr('file'), node.num('x'), node.num('y'), node.attr('pivot')), node);
      break;
    case 'text': {
      const name = node.attr('name', '');
      const str = subs.has(name) ? subs.get(name) : decodeText(node.attr('string', ''));
      n = applyCommon(new TextNode(node.attr('font'), str, node.num('x'), node.num('y'), node.attr('xAlign', 'left'), node.attr('yAlign', 'top')), node);
      break;
    }
    case 'imagebutton': n = applyCommon(new ImageButton(node), node); break;
    case 'textbutton': n = applyCommon(new TextButton(node), node); break;
    case 'checkbox': n = applyCommon(new CheckBox(node), node); break;
    case 'particlesystem': {
      const as = node.attr('autoStop');
      n = applyCommon(new ParticleNode(node.attr('file'), node.num('x'), node.num('y'), as === undefined ? undefined : parseFloat(as)), node);
      break;
    }
    case 'include': {
      const doc = assets.xml(node.attr('file'));
      if (doc) for (const c of doc.elements()) build(c, parent, subs);
      return;
    }
    default:
      return;
  }
  parent.add(n);
}

export class Screen extends Node {
  constructor(xmlPath, onAction) {
    super();
    this.onAction = onAction || (() => {});
    const doc = typeof xmlPath === 'string' ? assets.xml(xmlPath) : xmlPath;
    this.doc = doc;
    if (!doc) return;
    this.name = doc.attr('name', '');
    // <textSub name string> replaces the string of a text node from an include
    const subs = new Map();
    for (const s of doc.elements('textSub')) subs.set(s.attr('name'), decodeText(s.attr('string', '')));
    for (const c of doc.elements()) build(c, this, subs);
    this.buttons = this.findAll(n => n instanceof Button);
    this.pressedBtn = null;
  }
  setText(name, text) {
    const n = this.find(name);
    if (n && 'text' in n) n.text = text;
    return n;
  }
  show(name, on) {
    const n = this.find(name);
    if (n) n.visible = on;
    return n;
  }
  refreshButtons() { this.buttons = this.findAll(n => n instanceof Button); }

  pointerMove(x, y) {
    for (const b of this.buttons) {
      const h = b.hit(x, y);
      if (h && !b.hover && b.overSound) audio.play('mouseOver');
      b.hover = h;
    }
  }
  pointerDown(x, y) {
    this.pointerMove(x, y);
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      if (b.hit(x, y)) { b.pressed = true; this.pressedBtn = b; return true; }
    }
    return false;
  }
  pointerUp(x, y) {
    const b = this.pressedBtn;
    this.pressedBtn = null;
    for (const btn of this.buttons) btn.pressed = false;
    if (b && b.hit(x, y)) {
      if (b.activeSound) audio.play(b.activeSound);
      if (b instanceof CheckBox) b.checked = !b.checked;
      if (b.action) this.onAction(b.action, b);
      return true;
    }
    return false;
  }
  clearHover() { for (const b of this.buttons) { b.hover = false; b.pressed = false; } }
}
