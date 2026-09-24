// Particle systems (config/fx/*.xml) and splats (config/*splats.xml).
import { assets } from './assets.js';
import { BitmapFont } from './font.js';
import { parseRange, sample, parseVec, clamp, lerp } from './util.js';

function rangeAttr(node, name, def) {
  return node ? parseRange(node.attr(name), def) : parseRange(undefined, def);
}

class StreamDef {
  constructor(node) {
    this.emitRate = node.num('emitRate', 10);
    this.autoStop = node.num('autoStop', -1);
    this.startDelay = node.num('startDelay', 0);
    this.sequence = (node.attr('sequence') || 'random').toLowerCase();
    this.offset = parseVec(node.attr('offset'));
    this.maxParticles = node.num('maxParticles', 200);
    this.independent = /indep/i.test(node.attr('offsetType') || '');
    const res = node.first('resource');
    this.frames = res ? assets.frames(res.attr('path')) : [];
    const vel = node.first('velocity');
    this.vx = rangeAttr(vel, 'startX', 0);
    this.vy = rangeAttr(vel, 'startY', 0);
    const acc = node.first('acceleration');
    this.accel = rangeAttr(acc, 'rate', 0);
    const ext = node.first('extForce');
    this.force = ext ? parseVec(ext.attr('force')) : [0, 0];
    const pos = node.first('position');
    this.px = rangeAttr(pos, 'startX', 0);
    this.py = rangeAttr(pos, 'startY', 0);
    const sc = node.first('scale');
    this.s0 = rangeAttr(sc, 'startScale', 1);
    this.s1 = rangeAttr(sc, 'endScale', sc ? sample(this.s0) : 1);
    this.constScale = sc ? /true/i.test(sc.attr('constantScale') || sc.attr('constant') || '') : false;
    const life = node.first('particleLife');
    this.life = rangeAttr(life, 'lifeTime', 1);
    const op = node.first('opacity');
    this.o0 = rangeAttr(op, 'startOp', 1);
    this.o1 = rangeAttr(op, 'endOp', 1);
    const rot = node.first('rotation');
    this.rot = rot ? parseRange(rot.attr('degrees'), 0) : null;
    const jit = node.first('jitter');
    this.jitter = jit ? {
      axis: (jit.attr('axis') || 'X').toUpperCase(),
      amp: parseRange(jit.attr('amplitude'), 0),
      period: parseRange(jit.attr('period'), 1),
    } : null;
    const bh = node.first('blackHole');
    this.blackHole = bh ? { pos: parseVec(bh.attr('pos')), accel: bh.num('accel', 0) } : null;
  }
}

const defCache = new Map();
function systemDef(path) {
  if (defCache.has(path)) return defCache.get(path);
  const doc = assets.xml(path);
  const def = doc ? {
    autoStop: doc.num('autoStop', -1),
    streams: doc.elements('particleStream').map(s => new StreamDef(s)),
  } : null;
  defCache.set(path, def);
  return def;
}

export class ParticleSystem {
  // x, y: emitter position in the coordinate space it is drawn in
  constructor(path, x = 0, y = 0, opts = {}) {
    this.def = systemDef(path);
    this.x = x; this.y = y;
    this.age = 0;
    this.particles = [];
    this.stopped = false;
    this.autoStop = opts.autoStop ?? (this.def ? this.def.autoStop : 0);
    this.scale = opts.scale || 1;
    this.acc = this.def ? this.def.streams.map(() => 0) : [];
    this.visible = true;
    this.warmup = opts.warmup || 0;
    if (this.warmup) for (let t = 0; t < this.warmup; t += 1 / 20) this.update(1 / 20);
  }
  get dead() { return !this.def || (this.stopped && this.particles.length === 0); }
  stop() { this.stopped = true; }

  update(dt) {
    if (!this.def) return;
    this.age += dt;
    if (this.autoStop > 0 && this.age >= this.autoStop) this.stopped = true;
    if (!this.stopped) {
      this.def.streams.forEach((s, i) => {
        if (this.age < s.startDelay) return;
        if (s.autoStop > 0 && this.age > s.autoStop + s.startDelay) return;
        this.acc[i] += s.emitRate * dt;
        while (this.acc[i] >= 1) {
          this.acc[i] -= 1;
          if (this.particles.length < s.maxParticles * this.def.streams.length) this.emit(s);
        }
      });
    }
    for (const p of this.particles) {
      p.t += dt;
      const sp = Math.hypot(p.vx, p.vy);
      if (p.accel && sp > 0) {
        const ns = Math.max(0, sp + p.accel * dt);
        p.vx *= ns / sp; p.vy *= ns / sp;
      }
      p.vx += p.s.force[0] * dt;
      p.vy += p.s.force[1] * dt;
      if (p.s.blackHole) {
        const dx = p.s.blackHole.pos[0] - p.x, dy = p.s.blackHole.pos[1] - p.y;
        const d = Math.hypot(dx, dy) || 1;
        p.vx += dx / d * p.s.blackHole.accel * dt;
        p.vy += dy / d * p.s.blackHole.accel * dt;
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    this.particles = this.particles.filter(p => p.t < p.life);
  }

  emit(s) {
    const frame = s.frames.length ? Math.floor(Math.random() * s.frames.length) : 0;
    this.particles.push({
      s, t: 0,
      life: Math.max(0.01, sample(s.life)),
      x: s.offset[0] + sample(s.px), y: s.offset[1] + sample(s.py),
      ox: s.independent ? this.x : null, oy: s.independent ? this.y : null,
      vx: sample(s.vx), vy: sample(s.vy),
      accel: sample(s.accel),
      s0: sample(s.s0), s1: sample(s.s1),
      o0: sample(s.o0), o1: sample(s.o1),
      rot: s.rot ? sample(s.rot) * Math.PI / 180 : 0,
      jAmp: s.jitter ? sample(s.jitter.amp) : 0,
      jPer: s.jitter ? Math.max(0.1, sample(s.jitter.period)) : 1,
      frame,
    });
  }

  draw(ctx) {
    if (!this.visible) return;
    for (const p of this.particles) {
      const s = p.s;
      if (!s.frames.length) continue;
      const k = p.t / p.life;
      let fi = p.frame;
      if (s.sequence === 'sequence' && s.frames.length > 1) fi = Math.min(s.frames.length - 1, Math.floor(k * s.frames.length));
      const img = s.frames[fi];
      const scale = (s.constScale ? p.s0 : lerp(p.s0, p.s1, k)) * this.scale;
      const alpha = clamp(lerp(p.o0, p.o1, k), 0, 1);
      if (alpha <= 0.003 || scale <= 0) continue;
      let x = (p.ox ?? this.x) + p.x, y = (p.oy ?? this.y) + p.y;
      if (s.jitter) {
        const off = Math.sin(p.t / p.jPer * Math.PI * 2) * p.jAmp * 12;
        if (s.jitter.axis === 'X') x += off; else y += off;
      }
      ctx.globalAlpha = alpha;
      const w = img.w * scale, h = img.h * scale;
      if (p.rot) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.rot);
        ctx.drawImage(img.img, -w / 2, -h / 2, w, h);
        ctx.restore();
      } else {
        ctx.drawImage(img.img, x - w / 2, y - h / 2, w, h);
      }
    }
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- splats --

class SplatDef {
  constructor(node) {
    this.name = node.attr('name');
    this.life = node.num('lifeTime', 1);
    const vel = node.first('velocity');
    this.vx = rangeAttr(vel, 'startX', 0);
    this.vy = rangeAttr(vel, 'startY', 0);
    const ext = node.first('extForce');
    this.force = ext ? parseVec(ext.attr('force')) : [0, 0];
    const acc = node.first('acceleration');
    this.accel = rangeAttr(acc, 'rate', 0);
    const sc = node.first('scale');
    this.s0 = rangeAttr(sc, 'startScale', 1);
    this.s1 = rangeAttr(sc, 'endScale', 1);
    const op = node.first('opacity');
    this.o0 = rangeAttr(op, 'startOp', 1);
    this.o1 = rangeAttr(op, 'endOp', op ? 0 : 1);
    const dst = node.first('destination');
    this.dest = dst ? parseVec(dst.attr('pos')) : null;
    const res = node.first('resource');
    this.type = res ? (res.attr('type') || 'image') : 'image';
    this.image = res && this.type === 'image' ? assets.image(res.attr('path')) : null;
    this.font = res && this.type === 'text' ? BitmapFont.get(res.attr('font')) : null;
    this.text = res ? res.attr('text') || '' : '';
  }
}

export class SplatFactory {
  constructor(...paths) {
    this.defs = new Map();
    for (const p of paths) {
      const doc = assets.xml(p);
      if (!doc) continue;
      for (const s of doc.elements('splat')) this.defs.set(s.attr('name'), new SplatDef(s));
    }
    this.active = [];
  }
  has(name) { return this.defs.has(name); }
  spawn(name, x, y, text, opts = {}) {
    const d = this.defs.get(name);
    if (!d) return;
    this.active.push({
      d, x, y, x0: x, y0: y, t: 0,
      vx: sample(d.vx), vy: sample(d.vy), accel: sample(d.accel),
      s0: sample(d.s0), s1: sample(d.s1),
      text: text ?? d.text,
      layer: opts.layer || 'world',
      delay: opts.delay || 0,
    });
  }
  update(dt) {
    for (const s of this.active) {
      if (s.delay > 0) { s.delay -= dt; continue; }
      s.t += dt;
      const sp = Math.hypot(s.vx, s.vy);
      if (s.accel && sp > 0) {
        const ns = Math.max(0, sp + s.accel * dt);
        s.vx *= ns / sp; s.vy *= ns / sp;
      }
      s.vx += s.d.force[0] * dt; s.vy += s.d.force[1] * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
    }
    this.active = this.active.filter(s => s.t < s.d.life);
  }
  draw(ctx, layer) {
    for (const s of this.active) {
      if (s.layer !== layer || s.delay > 0) continue;
      const d = s.d, k = clamp(s.t / d.life, 0, 1);
      let x = s.x, y = s.y;
      if (d.dest) {
        const e = k * k;
        x = lerp(s.x0, d.dest[0], e);
        y = lerp(s.y0, d.dest[1], e);
      }
      const scale = lerp(s.s0, s.s1, k);
      const a = clamp(lerp(sample(d.o0), sample(d.o1), k), 0, 1);
      ctx.globalAlpha = a;
      if (d.image) {
        const w = d.image.w * scale, h = d.image.h * scale;
        ctx.drawImage(d.image.img, x - w / 2, y - h / 2, w, h);
      } else if (d.font && s.text) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(scale, scale);
        const m = d.font.measure(s.text);
        d.font.draw(ctx, s.text, 0, -m.h / 2, 'center');
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }
}
