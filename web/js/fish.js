// Fish: templates from config/fish/*.xml and the enemy behaviours of the
// original FishBase class family (wander / chase / run script states, sight
// checks against <react> tables, special classes such as jellyfish, mines,
// oysters, puffers and bonus bubbles).
import { assets } from './assets.js';
import { audio } from './audio.js';
import { parseRange, sample, parseVec, rand, clamp, pick, normPath } from './util.js';

// ----------------------------------------------------------------- templates --

const defCache = new Map();

export class FishDef {
  constructor(path, node) {
    this.path = path;
    const a = (n, d) => node.attr(n, d);
    this.name = a('name', path);
    this.cls = a('class', 'SoldierFish');
    if (this.cls === 'BrineShrip') this.cls = 'BrineShrimp';
    this.foodValue = node.num('foodValue', 0);
    this.maxSpeedX = parseRange(a('maxSpeedX'), 100);
    this.maxSpeedY = parseRange(a('maxSpeedY'), 50);
    this.minSpeedX = a('minSpeedX') !== undefined ? parseRange(a('minSpeedX'), 0) : null;
    this.minSpeedY = a('minSpeedY') !== undefined ? parseRange(a('minSpeedY'), 0) : null;
    this.sightDist = node.num('sightDist', 0);
    this.sightAngle = node.num('sightAngle', 45);
    this.accelRate = parseRange(a('accelRate'), 200);
    this.dragRate = node.num('dragRate', 40);
    this.scale = node.num('scale', 1);
    this.size = node.num('size', 1);
    this.spawnType = (a('spawnType', 'offStageLR') || '').toLowerCase();
    this.layer = (a('layer', '') || '').toLowerCase();
    this.animPath = normPath(a('animPath', ''));
    if (this.animPath && !this.animPath.endsWith('/') && !/[a-z]$/.test(this.animPath)) this.animPath += '/';
    this.hotSpot = a('hotSpot') ? parseVec(a('hotSpot'), [0, 0, 0, 0]) : null;
    this.collision = a('collision') ? parseVec(a('collision'), [0, 0, 0, 0]) : null;
    this.tailSpot = a('tailSpot') ? parseVec(a('tailSpot'), [0, 0, 0, 0]) : null;
    this.hsv = a('hsvOffset') ? parseVec(a('hsvOffset'), [0, 0, 0]) : null;
    this.sightCheckFreq = node.num('sightCheckFreq', 0.1);
    const f = (n, d) => parseRange(a(n), d);
    this.wanderMove = f('wanderMoveChangeFreq', 3);
    this.wanderState = parseRange(a('wanderStateChangeFreq') || a('wanderStageChangeFreq'), 4);
    this.chaseMove = f('chaseMoveChangeFreq', 0.6);
    this.chaseState = f('chaseStateChangeFreq', 3);
    this.runMove = f('runMoveChangeFreq', 1);
    this.runState = f('runStateChangeFreq', 2);
    this.schoolSize = node.num('schoolSize', 0);
    this.schoolDist = node.num('schoolDist', 40);
    this.reacts = node.elements('react').map(r => ({
      cls: r.attr('class'),
      reaction: (r.attr('reaction') || '').toLowerCase(),
      freq: r.num('reactFreq', r.num('reactionFreq', 1)),
    }));
    const snd = node.elements('sound').find(s => s.attr('class') === 'eaten');
    this.eatenSound = snd ? { name: snd.attr('name'), pitch: snd.num('pitch', 1) } : null;
    const mi = node.first('menuImage');
    this.menuOn = mi ? assets.image(mi.attr('onImage')) : null;
    this.menuOff = mi ? assets.image(mi.attr('offImage')) : null;
    if (!this.menuOn && this.animPath) this.menuOn = assets.image(this.animPath + 'hudimage.png');
    this.anims = loadAnims(this);
  }
  static get(path) {
    const k = normPath(path);
    if (defCache.has(k)) return defCache.get(k);
    const doc = assets.xml(k);
    const def = doc ? new FishDef(k, doc) : null;
    defCache.set(k, def);
    return def;
  }
}

function loadAnims(def) {
  const p = def.animPath;
  const anims = {};
  const get = (sub) => assets.frames(p + sub);
  anims.swim = get('swim/swim_cycle.');
  anims.turn = get('turn/turn_cycle.');
  anims.eat = get('eat/eat_cycle.');
  anims.idle = get('idle/idle_cycle.');
  anims.puff = get('puff/puff_cycle.');
  if (!anims.swim.length) {
    // single-directory animations: jellyfish, mines, bonus bubbles, oysters
    const tries = { basicjellyfish: 'jelly.', mine: 'mine', oyster: 'open.' };
    const k = def.cls.toLowerCase();
    anims.swim = tries[k] ? get(tries[k]) : [];
    if (!anims.swim.length) anims.swim = assets.frames(p);
  }
  if (def.cls === 'Mine') anims.explode = get('explode.');
  return anims;
}

// ------------------------------------------------------------------- fish --

const FPS = { swim: 18, turn: 22, eat: 22, idle: 12, puff: 20, explode: 14 };
const PREDATOR_CLASSES = new Set(['AngelFish', 'SoldierFish', 'ChaserFish', 'Barracuda', 'PufferFish', 'FlyByFish', 'Shark', 'Mermaid']);
const HAZARD = new Set(['BasicJellyFish', 'Mine']);
const BONUS = new Set(['BonusBubbleStar', 'BonusBubbleShield', 'BonusBubbleStun', 'BonusBubbleFeedingFury', 'BonusBubbleFreeLife', 'BonusBubbleSpeed', 'BonusBubble2X']);

export class Fish {
  constructor(def, stage, group) {
    this.def = def;
    this.cls = def.cls;
    this.stage = stage;
    this.group = group;
    this.isPlayer = false;
    this.scale = def.scale;
    this.size = def.size;
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.facing = -1; // -1 = left (sprite default), 1 = right
    this.alive = true;
    this.anim = 'swim'; this.frame = 0; this.animT = 0; this.animOnce = false;
    this.turning = 0;
    this.state = 'wander';
    this.stateT = 0; this.moveT = 0; this.sightT = rand(0, def.sightCheckFreq);
    this.target = null;
    this.stunT = 0;
    this.hsv = def.hsv;
    this.maxX = sample(def.maxSpeedX);
    this.maxY = sample(def.maxSpeedY);
    this.minX = def.minSpeedX ? sample(def.minSpeedX) : this.maxX * 0.45;
    this.accel = sample(def.accelRate);
    this.tx = 0; this.ty = 0; // desired velocity
    this.school = null;
    this.flash = 0;
    this.eatenBy = null;
    this.counted = true;
    this.bob = rand(0, Math.PI * 2);
  }

  get isBonus() { return BONUS.has(this.cls); }
  get isHazard() { return HAZARD.has(this.cls); }
  get edibleByPlayer() { return !this.isHazard && this.cls !== 'Mermaid'; }

  frames(name = this.anim) {
    const f = this.def.anims[name];
    return f && f.length ? f : this.def.anims.swim;
  }
  get img() {
    const fr = this.frames();
    if (!fr.length) return null;
    return fr[Math.min(fr.length - 1, this.frame)];
  }
  get w() { const i = this.def.anims.swim[0]; return i ? i.w * this.scale : 40; }
  get h() { const i = this.def.anims.swim[0]; return i ? i.h * this.scale : 40; }

  play(name, once = false) {
    if (!this.def.anims[name] || !this.def.anims[name].length) return false;
    this.anim = name; this.frame = 0; this.animT = 0; this.animOnce = once;
    return true;
  }

  updateAnim(dt) {
    const fr = this.frames();
    const speedMul = this.anim === 'swim' ? clamp(0.6 + Math.hypot(this.vx, this.vy) / Math.max(60, this.maxX), 0.6, 1.8) : 1;
    this.animT += dt * (FPS[this.anim] || 18) * speedMul;
    while (this.animT >= 1) {
      this.animT -= 1;
      this.frame++;
      if (this.frame >= fr.length) {
        if (this.animOnce) { this.onAnimEnd(this.anim); return; }
        this.frame = 0;
      }
    }
  }

  onAnimEnd(name) {
    if (name === 'turn') {
      this.facing = this.turning;
      this.turning = 0;
    }
    if (name === 'explode') { this.alive = false; return; }
    if (name === 'puff') { this.frame = this.frames().length - 1; this.animOnce = false; this.anim = 'puffed'; return; }
    this.play('swim');
  }

  // desired facing from velocity (FUN_00406400: turn when |vx| > 15)
  updateFacing() {
    if (this.turning || this.anim === 'eat' || this.noTurn) return;
    const want = this.vx > 15 ? 1 : this.vx < -15 ? -1 : this.facing;
    if (want !== this.facing) {
      if (this.play('turn', true)) this.turning = want;
      else this.facing = want;
    }
  }

  // sprite pixel rect -> world rect, mirroring when facing right
  spriteRect(r) {
    const s = this.scale, img0 = this.def.anims.swim[0];
    const W = (img0 ? img0.w : 40) * s, H = (img0 ? img0.h : 40) * s;
    if (r[0] < 0 || r[1] < 0) { // centre-relative (mines)
      return { x1: this.x + r[0] * s, y1: this.y + r[1] * s, x2: this.x + r[2] * s, y2: this.y + r[3] * s };
    }
    const left = this.x - W / 2, top = this.y - H / 2;
    const face = this.drawFacing();
    if (face < 0) return { x1: left + r[0] * s, x2: left + r[2] * s, y1: top + r[1] * s, y2: top + r[3] * s };
    return { x1: this.x + W / 2 - r[2] * s, x2: this.x + W / 2 - r[0] * s, y1: top + r[1] * s, y2: top + r[3] * s };
  }
  drawFacing() { return this.turning ? (this.frame < this.frames().length / 2 ? -this.turning : this.turning) : this.facing; }

  bodyRect() {
    if (this.def.collision) return this.spriteRect(this.def.collision);
    const w = this.w * 0.8, h = this.h * 0.8;
    return { x1: this.x - w / 2, x2: this.x + w / 2, y1: this.y - h / 2, y2: this.y + h / 2 };
  }

  // hotSpot is relative to the leading edge of the collision rect at its centre line
  mouthRect() {
    const hs = this.def.hotSpot || [-24, -24, 24, 24];
    const s = this.scale;
    const body = this.def.collision ? this.spriteRect(this.def.collision) : this.bodyRect();
    if (this.def.collision && (this.def.collision[0] < 0)) {
      return { x1: this.x + hs[0] * s, x2: this.x + hs[2] * s, y1: this.y + hs[1] * s, y2: this.y + hs[3] * s };
    }
    const cy = (body.y1 + body.y2) / 2;
    const face = this.drawFacing();
    if (face < 0) {
      const ax = body.x1;
      return { x1: ax + hs[0] * s, x2: ax + hs[2] * s, y1: cy + hs[1] * s, y2: cy + hs[3] * s };
    }
    const ax = body.x2;
    return { x1: ax - hs[2] * s, x2: ax - hs[0] * s, y1: cy + hs[1] * s, y2: cy + hs[3] * s };
  }

  canEat(other) {
    if (!other.alive || other === this || other.eatenBy) return false;
    if (other.isHazard || this.isHazard || this.isBonus) return false;
    if (other.isBonus && !this.isPlayer) return false;
    if (other.cls === 'Oyster' && !this.isPlayer) return false;
    if (other.puffed) return false;
    if (other.isPlayer) return other.edibleBy(this);
    return other.size < this.size;
  }

  // -------------------------------------------------------------- spawning --

  spawn(opts = {}) {
    const st = this.stage;
    const margin = Math.max(this.w, this.h) * 0.6 + 10;
    const type = opts.spawnType || this.def.spawnType;
    const top = 90, bottom = st.height - 30;
    if (opts.x !== undefined) {
      this.x = opts.x; this.y = opts.y;
      this.facing = opts.facing || (Math.random() < 0.5 ? -1 : 1);
    } else if (type.includes('top')) {
      this.x = rand(margin, st.width - margin);
      this.y = -margin;
      this.facing = Math.random() < 0.5 ? -1 : 1;
    } else if (type.includes('bottom')) {
      this.x = rand(margin, st.width - margin);
      this.y = st.height + margin;
      this.facing = Math.random() < 0.5 ? -1 : 1;
    } else {
      const fromLeft = opts.fromLeft ?? Math.random() < 0.5;
      this.x = fromLeft ? -margin : st.width + margin;
      this.y = opts.y ?? rand(top + this.h / 2, bottom - this.h / 2);
      this.facing = fromLeft ? 1 : -1;
    }
    this.dir = this.facing;
    this.vx = this.facing * this.minX;
    this.vy = 0;
    this.pickWanderMove();
    this.stateT = sample(this.def.wanderState);
    this.initClass();
  }

  initClass() {
    switch (this.cls) {
      case 'BasicJellyFish':
        this.noTurn = true;
        this.vy = -this.maxY; this.vx = 0;
        break;
      case 'Mine':
        this.noTurn = true;
        this.vy = Math.abs(this.maxY) * 0.8; this.vx = 0;
        this.fuse = 0;
        break;
      case 'Oyster':
        this.noTurn = true;
        this.vx = this.vy = 0;
        this.oyster = { phase: 'closed', t: rand(1, 3), pearl: 0 };
        this.frame = 0;
        break;
      case 'Barracuda':
        this.warnT = 1.4;
        this.state = 'warn';
        this.vx = 0;
        break;
      default:
        if (this.isBonus) {
          this.noTurn = true;
          this.vx = rand(-1, 1) * this.maxX;
          this.vy = this.def.spawnType.includes('top') ? Math.abs(this.maxY) : -Math.abs(this.maxY);
        }
    }
  }

  pickWanderMove() {
    const speed = rand(this.minX, this.maxX);
    this.tx = this.dir * speed;
    this.ty = rand(-1, 1) * this.maxY * 0.6;
    this.moveT = sample(this.def.wanderMove);
  }

  // -------------------------------------------------------------- behaviour --

  update(dt) {
    if (!this.alive) return;
    this.updateAnim(dt);
    if (!this.alive) return;
    if (this.flash > 0) this.flash -= dt;
    if (this.stunT > 0) {
      this.stunT -= dt;
      this.vx *= Math.max(0, 1 - 4 * dt); this.vy *= Math.max(0, 1 - 4 * dt);
      this.x += this.vx * dt; this.y += this.vy * dt;
      if (this.stunT <= 0 && this.stunFx) { this.stunFx.stop(); this.stunFx = null; }
      return;
    }
    switch (this.cls) {
      case 'BasicJellyFish': return this.updateJelly(dt);
      case 'Mine': return this.updateMine(dt);
      case 'Oyster': return this.updateOyster(dt);
      default:
        if (this.isBonus) return this.updateBubble(dt);
    }
    if (this.state === 'warn') return this.updateBarracudaWarn(dt);
    this.think(dt);
    this.steer(dt);
    this.updateFacing();
    this.checkExit();
  }

  think(dt) {
    const d = this.def;
    this.stateT -= dt;
    this.moveT -= dt;
    this.sightT -= dt;
    if (this.state !== 'wander' && (!this.target || !this.target.alive || this.target.eatenBy)) this.toWander();
    if (this.stateT <= 0) {
      if (this.state === 'wander') {
        // occasionally reverse while well inside the stage
        const st = this.stage;
        if (this.x > 80 && this.x < st.width - 80 && Math.random() < 0.25 && !this.passThrough) this.dir = -this.dir;
        this.stateT = sample(d.wanderState);
      } else this.toWander();
    }
    if (this.moveT <= 0) {
      if (this.state === 'wander') this.pickWanderMove();
      else this.moveT = sample(this.state === 'chase' ? d.chaseMove : d.runMove);
    }
    if (this.sightT <= 0 && d.sightDist > 0 && d.reacts.length) {
      this.sightT = d.sightCheckFreq > 5 ? 1e9 : d.sightCheckFreq;
      this.sightCheck();
    }
    // SuicideFish/schools follow their leader
    if (this.school && this.school.leader !== this && this.school.leader.alive && this.state === 'wander') {
      const L = this.school.leader;
      this.tx = L.vx + (L.x + this.schoolOff[0] - this.x) * 1.5;
      this.ty = L.vy + (L.y + this.schoolOff[1] - this.y) * 1.5;
      this.dir = L.dir;
    }
    if (this.state === 'chase' && this.target) {
      const dx = this.target.x - this.x, dy = this.target.y - this.y;
      const dist = Math.hypot(dx, dy) || 1;
      const sp = this.maxX * (this.school ? 1.1 : 1.15);
      this.tx = dx / dist * sp;
      this.ty = clamp(dy / dist * sp, -this.maxY * 2.2, this.maxY * 2.2);
      this.dir = Math.sign(dx) || this.dir;
    } else if (this.state === 'run' && this.target) {
      const dx = this.x - this.target.x, dy = this.y - this.target.y;
      const dist = Math.hypot(dx, dy) || 1;
      const sp = this.maxX * 1.2;
      this.tx = dx / dist * sp;
      this.ty = clamp(dy / dist * sp, -this.maxY * 2, this.maxY * 2);
      this.dir = Math.sign(dx) || this.dir;
    }
  }

  toWander() {
    this.state = 'wander';
    this.target = null;
    this.stateT = sample(this.def.wanderState);
    this.pickWanderMove();
  }

  canSee(o) {
    const dx = o.x - this.x, dy = o.y - this.y;
    const dist = Math.hypot(dx, dy);
    const range = this.def.sightDist + Math.max(o.w, o.h) * 0.3;
    if (dist > range) return false;
    if (dist < 60) return true;
    // view cone around the facing direction (sightAngle = half-angle, degrees)
    const ang = Math.abs(Math.atan2(dy, dx * this.facing)) * 180 / Math.PI;
    return ang <= Math.max(this.def.sightAngle, 25) * 1.5;
  }

  sightCheck() {
    const st = this.stage;
    const candidates = st.fish.concat(st.player && st.player.alive && st.player.visibleToFish ? [st.player] : []);
    let best = null, bestPri = -1, bestDist = Infinity;
    for (const o of candidates) {
      if (o === this || !o.alive || o.eatenBy) continue;
      const cls = o.isPlayer ? 'PlayerFish' : o.cls;
      const r = this.def.reacts.find(r => r.cls === cls);
      if (!r || !this.canSee(o)) continue;
      let reaction = r.reaction;
      if (reaction === 'chase' && !this.canEat(o)) continue;
      if ((reaction === 'avoid' || reaction === 'run') && !o.isHazard && !o.canEat?.(this) && !(o.isPlayer && o.size > this.size)) {
        // only flee from things that can actually eat us (or hazards)
        if (!o.isPlayer) continue;
      }
      if (reaction === 'special') reaction = this.cls === 'PufferFish' ? 'puff' : 'chase';
      const pri = reaction === 'avoid' || reaction === 'run' ? 2 : 1;
      const dist = Math.hypot(o.x - this.x, o.y - this.y);
      if (pri > bestPri || (pri === bestPri && dist < bestDist)) { best = { o, reaction, freq: r.freq }; bestPri = pri; bestDist = dist; }
    }
    if (!best || Math.random() > best.freq) return;
    const { o, reaction } = best;
    if (reaction === 'puff') { this.startPuff(); return; }
    if (reaction === 'chase') {
      if (this.state !== 'chase' || this.target !== o) {
        this.state = 'chase'; this.target = o;
        this.stateT = sample(this.def.chaseState);
        this.moveT = sample(this.def.chaseMove);
      }
    } else if (reaction === 'avoid' || reaction === 'run') {
      this.state = 'run'; this.target = o;
      this.stateT = sample(this.def.runState);
      this.moveT = sample(this.def.runMove);
      if (this.cls === 'PufferFish' && o.isPlayer && o.size > this.size) this.startPuff();
    }
  }

  steer(dt) {
    const bounce = this.cls === 'SuicideFish' ? 1 : 1;
    // vertical containment: keep inside the playfield
    const st = this.stage;
    const top = 95 + this.h * 0.3, bottom = st.height - 10 - this.h * 0.3;
    if (this.y < top && this.ty < 0) this.ty = Math.abs(this.ty) * 0.5 + 20;
    if (this.y > bottom && this.ty > 0) this.ty = -Math.abs(this.ty) * 0.5 - 20;
    const ax = this.tx - this.vx, ay = this.ty - this.vy;
    const am = Math.hypot(ax, ay);
    const maxA = this.accel * dt * bounce;
    if (am > maxA) { this.vx += ax / am * maxA; this.vy += ay / am * maxA; } else { this.vx = this.tx; this.vy = this.ty; }
    if (this.puffed) { this.vx *= 0.9; this.vy *= 0.9; }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  checkExit() {
    const st = this.stage, m = Math.max(this.w, this.h) * 0.7 + 30;
    const out = this.x < -m || this.x > st.width + m || this.y < -m * 2 || this.y > st.height + m * 2;
    if (out && this.entered) this.remove();
    if (!out) this.entered = true;
    // never linger forever off-stage
    if (!this.entered) {
      this.lostT = (this.lostT || 0) + 1 / 60;
      if (this.lostT > 12) this.remove();
    }
  }

  remove() { this.alive = false; this.removed = true; }

  // ------------------------------------------------------------ specials --

  updateJelly(dt) {
    this.bob += dt * 2;
    this.vx = Math.sin(this.bob) * Math.abs(this.maxX) * 2;
    this.y += this.vy * dt;
    this.x += this.vx * dt;
    if (this.y < -this.h) this.remove();
  }

  updateMine(dt) {
    if (this.exploding) return;
    this.bob += dt * 1.5;
    const floor = this.stage.height - this.h * 0.5 - 8;
    if (this.y < floor) {
      this.y += this.vy * dt;
      this.x += Math.sin(this.bob) * 12 * dt;
    } else {
      this.y = floor;
      this.lifeT = (this.lifeT || 0) + dt;
      if (this.lifeT > 12) this.explode(false);
    }
  }

  explode(byPlayer = true) {
    if (this.exploding) return;
    this.exploding = true;
    audio.play('mineExplode');
    this.stage.addFx('config/fx/mineexplosion.xml', this.x, this.y);
    this.scale = Math.max(this.scale, 1);
    if (!this.play('explode', true)) this.alive = false;
    // blast radius stuns / destroys nearby fish
    for (const f of this.stage.fish) {
      if (f === this || !f.alive || f.isHazard) continue;
      if (Math.hypot(f.x - this.x, f.y - this.y) < 110) f.stun(2.5);
    }
    void byPlayer;
  }

  updateOyster(dt) {
    const o = this.oyster;
    o.t -= dt;
    const openFrames = this.frames('swim').length;
    if (o.phase === 'closed' && o.t <= 0) { o.phase = 'opening'; this.frame = 0; this.animT = 0; o.pearl = pearlType(); }
    else if (o.phase === 'opening') {
      this.animT += dt * 10;
      this.frame = Math.min(openFrames - 1, Math.floor(this.animT));
      if (this.animT >= openFrames) { o.phase = 'open'; o.t = rand(2.5, 4.5); }
    } else if (o.phase === 'open' && o.t <= 0) { o.phase = 'closing'; this.animT = openFrames; }
    else if (o.phase === 'closing') {
      this.animT -= dt * 14;
      this.frame = Math.max(0, Math.floor(this.animT));
      if (this.animT <= 0) {
        o.phase = 'closed'; o.t = rand(2, 5); this.frame = 0;
        const p = this.stage.player;
        if (p && p.alive && rectsHit(p.mouthRect(), this.pearlRect())) p.oysterBite(this);
      }
    }
    // hold anim frame (no auto-advance)
    this.anim = 'swim';
    this.animOnce = false;
  }
  pearlRect() { return this.mouthRect(); }
  get pearlAvailable() { return this.cls === 'Oyster' && this.oyster && this.oyster.phase === 'open' && this.oyster.pearl >= 0; }

  updateBubble(dt) {
    this.bob += dt * 3;
    this.x += (this.vx * 0.2 + Math.sin(this.bob) * 20) * dt;
    this.y += this.vy * dt;
    const m = this.h + 20;
    if (this.y < -m || this.y > this.stage.height + m) this.remove();
  }

  updateBarracudaWarn(dt) {
    this.warnT -= dt;
    if (!this.warned) {
      this.warned = true;
      const p = this.stage.player;
      if (p) this.y = clamp(p.y, 120, this.stage.height - 40);
      audio.play('dangerSound');
      this.stage.showDanger(this);
      this.stage.onDanger?.();
    }
    if (this.warnT <= 0) {
      this.state = 'wander';
      this.passThrough = true;
      this.tx = this.dir * this.maxX;
      this.vx = this.dir * this.maxX;
      this.ty = 0;
      this.stateT = 99;
      this.moveT = 99;
    }
  }

  startPuff() {
    if (this.puffed || !this.def.anims.puff.length) return;
    this.puffed = true;
    this.puffT = rand(2.5, 4);
    this.play('puff', true);
    audio.play('pufferBounce', { vol: 0.4 });
  }

  stun(t) {
    if (this.isHazard || this.isBonus || this.cls === 'Oyster') return;
    this.stunT = Math.max(this.stunT, t);
    if (!this.stunFx) this.stunFx = this.stage.addFx('config/fx/stunnedeffect.xml', 0, 0, { follow: this, dy: -this.h * 0.35 });
  }

  lateUpdate(dt) {
    if (this.puffed) {
      this.puffT -= dt;
      if (this.puffT <= 0) { this.puffed = false; this.play('swim'); }
    }
  }

  // ---------------------------------------------------------------- draw --

  draw(ctx) {
    if (!this.alive) return;
    let img = this.anim === 'puffed' ? this.frames('puff').at(-1) : this.img;
    if (!img) return;
    if (this.hsv) img = assets.hsv(img, this.hsv[0], this.hsv[1], this.hsv[2]);
    const face = this.anim === 'turn' ? -this.turning : this.facing;
    const flip = this.anim === 'turn' ? this.turning < 0 : face > 0;
    const w = img.w * this.scale, h = img.h * this.scale;
    ctx.save();
    ctx.translate(this.x, this.y);
    if (flip) ctx.scale(-1, 1);
    if (this.flash > 0 && Math.floor(this.flash * 16) % 2) ctx.globalAlpha *= 0.4;
    ctx.drawImage(img.img, -w / 2, -h / 2, w, h);
    ctx.restore();
    if (this.cls === 'Oyster' && this.pearlAvailable) this.drawPearl(ctx);
  }

  drawPearl(ctx) {
    const img = assets.image(this.oyster.pearl === 1 ? 'resources/oyster/blackpearl.jpg' : 'resources/oyster/pearl.jpg');
    if (!img) return;
    const r = this.mouthRect();
    const s = this.scale * 0.9;
    ctx.drawImage(img.img, (r.x1 + r.x2) / 2 - img.w * s / 2, (r.y1 + r.y2) / 2 - img.h * s / 2 - 4, img.w * s, img.h * s);
  }
}

function pearlType() {
  const r = Math.random();
  return r < 0.04 ? 2 : r < 0.2 ? 1 : 0; // 2 = extra life, 1 = black pearl, 0 = white
}

export function rectsHit(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

export { PREDATOR_CLASSES, pick };
