// StageMgr: loads config/stages/<name>/stage.xml, runs the play field (layers,
// spawning, collisions, camera) and the in-game HUD (config/gameHud.xml).
import { assets } from './assets.js';
import { audio } from './audio.js';
import { BitmapFont } from './font.js';
import { Fish, FishDef, rectsHit } from './fish.js';
import { ParticleSystem, SplatFactory } from './particles.js';
import { Player } from './player.js';
import { Screen, ImageNode } from './scene.js';
import { VIEW_W, VIEW_H, clamp, fmtScore, fmtTime, parseRange, parseTime, parseVec, rand, sample } from './util.js';

const HUD_H = 84;

class SpawnGroup {
  constructor(node) {
    this.name = node.attr('name');
    this.def = FishDef.get(node.attr('template'));
    this.poolSize = node.num('poolSize', 5);
    this.mode = (node.attr('mode') || '').toLowerCase();
    this.displayMenu = node.attr('displayMenuImage') === undefined ? true : node.bool('displayMenuImage', true);
    this.infos = node.elements('spawnInfo').map(s => ({
      playerSize: s.num('playerSize', 0),
      maxCount: s.num('maxCount', 1),
      respawn: parseRange(s.attr('respawnFreq'), 2),
    })).sort((a, b) => a.playerSize - b.playerSize);
    this.statics = node.elements('staticSpawn').map(s => ({ pos: parseVec(s.attr('pos')), respawn: s.bool('doRespawn', false) }));
    this.timer = 0;
    this.eatenCount = 0;
    this.spawnedTotal = 0;
    this.alive = [];
  }
  get counted() { return this.mode !== 'uncounted'; }
  info(playerSize) {
    let cur = this.infos[0] || { maxCount: 0, respawn: { min: 5, max: 5 } };
    for (const i of this.infos) if (i.playerSize <= playerSize + 1e-6) cur = i;
    return cur;
  }
}

export class Stage {
  // game: the Game controller (for state + callbacks)
  constructor(game, stagePath, opts = {}) {
    this.game = game;
    this.path = stagePath;
    this.opts = opts;
    const doc = assets.xml(stagePath);
    if (!doc) throw new Error('missing stage ' + stagePath);
    this.doc = doc;
    this.friendlyName = doc.attr('friendlyName', doc.attr('name', ''));
    this.type = (doc.attr('type') || 'normal').toLowerCase();
    this.width = doc.num('stageWidth', 640);
    this.height = doc.num('stageHeight', 480);
    this.timeLimit = parseTime(doc.attr('time'));
    this.time = this.timeLimit;
    this.elapsed = 0;
    this.isMenu = this.type === 'menu' || !!opts.demo;
    this.isBonus = this.type === 'timedbonus';

    // environment layers
    const env = doc.first('environment');
    const layer = (k) => {
      const p = env && env.attr(k);
      if (!p) return null;
      const s = new Screen(p);
      s.parallax = this.layerParallax(s);
      return s;
    };
    this.bg = layer('bgLayout');
    this.mg = layer('mgLayout');
    this.fg = layer('fgLayout');

    // player
    const pf = doc.first('playerFish');
    const sizes = pf ? pf.elements('size').map(s => ({ size: s.num('size'), targetScore: s.num('targetScore'), scale: s.num('scale', 1) })) : [];
    this.player = new Player(this, pf ? pf.attr('config') : 'config/fish/angelplayer.xml', sizes);

    // enemies
    this.groups = doc.elements('enemyFish').map(n => new SpawnGroup(n)).filter(g => g.def);
    this.fish = [];

    // music
    const mus = doc.first('music');
    this.music = mus ? mus.attr('gameMusic') : null;
    this.introSound = mus ? mus.attr('introSound') : null;

    this.tooltips = doc.elements('toolTip').map(t => ({ file: t.attr('file'), type: t.attr('type'), delay: t.num('delay', 0.1) }));

    this.fx = [];
    this.splats = new SplatFactory('config/splats.xml', 'config/eatsplats.xml', 'config/hudsplats.xml');
    this.cam = { x: 0, y: 0 };
    this.state = 'play';
    this.stateT = 0;
    this.stars = { got: 0, total: 0 };
    this.eatenTotal = 0;
    this.messages = [];
    this.danger = [];
    this.pendingTips = [];

    this.hud = this.isMenu ? null : new Hud(this);
    this.frenzyFont = BitmapFont.get('resources/hud/frenzyfontwhite.xml');
  }

  // Scroll factor from the extent of a layer's content (see RE-NOTES §6)
  layerParallax(screen) {
    let maxX = 0, maxY = 0;
    for (const n of screen.findAll(n => n instanceof ImageNode)) {
      if (!n.image) continue;
      maxX = Math.max(maxX, n.x + (n.sx < 0 ? 0 : n.image.w * n.sx), n.x);
      maxY = Math.max(maxY, n.y + n.image.h * Math.abs(n.sy));
    }
    const fx = this.width > VIEW_W && maxX > VIEW_W ? clamp((Math.min(maxX, this.width * 1.6) - VIEW_W) / (this.width - VIEW_W), 0.4, 1.6) : 1;
    const fy = this.height > VIEW_H && maxY > VIEW_H ? clamp((Math.min(maxY, this.height * 1.6) - VIEW_H) / (this.height - VIEW_H), 0.4, 1.6) : 1;
    return { x: fx, y: fy };
  }

  start() {
    this.player.spawnPlayer();
    if (this.isMenu) { this.player.alive = false; this.player.state = 'dead'; this.player.deadT = 1e9; }
    // pre-populate so the stage is alive from the first frame
    for (const g of this.groups) {
      for (const s of g.statics) this.spawnFish(g, { x: s.pos[0], y: s.pos[1], static: s });
      const info = g.info(this.player.size);
      const n = Math.min(info.maxCount, Math.ceil(info.maxCount * 0.5));
      for (let i = 0; i < n; i++) {
        if (g.def.isBonusDef || /bonusbubble/i.test(g.def.cls) || g.def.cls === 'Barracuda' || g.def.cls === 'Mine' || g.statics.length) continue;
        this.spawnFish(g, { inside: true });
      }
      g.timer = sample(info.respawn) * 0.5;
    }
    if (this.music) audio.playMusic(this.music);
    if (this.introSound && !this.isMenu) audio.play(this.introSound);
    this.queueTips('levelStart');
  }

  // -------------------------------------------------------------- spawning --
  spawnFish(g, opts = {}) {
    const def = g.def;
    const n = def.schoolSize > 1 ? def.schoolSize : 1;
    if (g.alive.length + n > g.poolSize + (def.schoolSize > 1 ? def.schoolSize : 0)) return;
    if (g.mode === 'onlyuneaten' && g.eatenCount + g.alive.length >= g.poolSize) return;
    const school = n > 1 ? { members: [], leader: null, eaten: 0, size: n } : null;
    let leader = null;
    for (let i = 0; i < n; i++) {
      const f = new Fish(def, this, g);
      f.counted = g.counted;
      if (opts.static) {
        f.spawn({ x: opts.pos ? opts.pos[0] : opts.x, y: opts.y, facing: 1 });
        f.staticInfo = opts.static;
      } else if (leader) {
        const off = [rand(-1, 1) * def.schoolDist * 1.5, rand(-1, 1) * def.schoolDist];
        f.spawn({ x: leader.x + off[0] - leader.facing * i * def.schoolDist * 0.6, y: clamp(leader.y + off[1], 100, this.height - 30), facing: leader.facing });
        f.schoolOff = [f.x - leader.x, f.y - leader.y];
      } else if (opts.inside) {
        let x, y, tries = 0;
        do {
          x = rand(60, this.width - 60); y = rand(130, this.height - 40); tries++;
        } while (tries < 10 && Math.hypot(x - this.player.x, y - 160) < 220);
        f.spawn({ x, y, facing: Math.random() < 0.5 ? -1 : 1 });
        f.entered = true;
      } else {
        f.spawn();
      }
      f.dir = f.facing;
      if (school) { school.members.push(f); f.school = school; if (!leader) { leader = f; school.leader = f; f.schoolOff = [0, 0]; } }
      else leader = leader || null;
      if (!leader && !school) leader = null;
      if (f.isBonus && g.def.cls === 'BonusBubbleStar') this.stars.total++;
      g.alive.push(f);
      g.spawnedTotal++;
      this.fish.push(f);
    }
  }

  updateSpawns(dt) {
    if (this.state !== 'play') return;
    for (const g of this.groups) {
      g.alive = g.alive.filter(f => f.alive);
      // static spawns (oysters) respawn in place
      const info = g.info(this.player.size);
      if (g.statics.length) continue;
      if (g.alive.length >= info.maxCount) continue;
      g.timer -= dt;
      if (g.timer <= 0) {
        g.timer = sample(info.respawn);
        this.spawnFish(g);
      }
    }
  }

  // -------------------------------------------------------------- effects --
  addFx(path, x, y, opts = {}) {
    const ps = new ParticleSystem(path, x, y, { autoStop: opts.autoStop });
    ps.follow = opts.follow || null;
    ps.dy = opts.dy || 0;
    ps.layer = opts.layer || 'world';
    this.fx.push(ps);
    return ps;
  }

  toScreen(x, y) { return [x - this.cam.x, y - this.cam.y]; }

  onScreen(f) {
    return f.x > this.cam.x - 20 && f.x < this.cam.x + VIEW_W + 20 && f.y > this.cam.y + 60 && f.y < this.cam.y + VIEW_H + 20;
  }

  chompSplat(f, big) {
    const w = f.w;
    const kind = big || w > 160 ? 'Large' : w > 70 ? 'Small' : 'Mini';
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < 3; i++) this.splats.spawn('chompSplat' + kind + (((n + i) % 3) + 1), f.x, f.y, null, { layer: 'world', delay: i * 0.04 });
  }

  addScore(points, f) {
    const gs = this.game.state;
    if (this.isMenu) return;
    gs.addScore(points, this);
    const [sx, sy] = this.toScreen(f.x, f.y - 10);
    this.splats.spawn(points >= 0 ? 'playerEat' : 'playerEatNegative', sx, sy, (points >= 0 ? '+' : '') + points, { layer: 'hud' });
  }

  bonusText(text, f, negative) {
    const [sx, sy] = this.toScreen(f.x, f.y - 30);
    this.splats.spawn('bonusSplat', clamp(sx, 80, 560), clamp(sy, 120, 440), text, { layer: 'hud' });
    void negative;
  }

  frenzySplat(double) {
    const [sx, sy] = this.toScreen(this.player.x, this.player.y);
    this.splats.spawn(double ? 'doubleFrenzySplat' : 'frenzySplat', clamp(sx, 170, 470), clamp(sy - 40, 140, 420), null, { layer: 'hud' });
  }

  addLife(f) {
    if (this.game.state.mode !== 'time') {
      this.game.state.lives++;
      audio.play('extraLife');
      this.bonusText('Extra Life!', f);
    } else {
      this.time += 10;
      this.bonusText('+10 sec', f);
    }
  }

  starCollected(f) {
    this.stars.got++;
    this.game.state.addScore(0, this);
    this.bonusText('Bonus Star!', f);
  }

  stunAll(t) {
    for (const f of this.fish) if (f.alive && this.onScreen(f)) f.stun(t);
  }

  showDanger(f) {
    this.danger.push({ f, t: 1.4 });
    this.queueTips('danger');
  }

  // ------------------------------------------------------------- tooltips --
  queueTips(type) {
    if (this.isMenu || !this.game.options.tips) return;
    for (const t of this.tooltips) {
      if (t.type !== type || this.game.seenTip(t.file)) continue;
      this.pendingTips.push({ file: t.file, delay: t.delay });
    }
  }

  // --------------------------------------------------------------- events --
  onFishEaten(f) {
    this.eatenTotal++;
    const g = f.group;
    if (g) {
      g.eatenCount++;
      if (!f.isBonus && g.counted) this.game.state.foodBank += Math.max(0, f.def.foodValue);
    }
    if (f.school) {
      f.school.eaten++;
      if (f.school.eaten === f.school.size) {
        this.game.state.addScore(500, this);
        this.bonusText('School Bonus!', f);
        audio.play('schoolBonus');
      }
    }
    this.queueTips('fishEaten');
    if (this.isBonus) {
      const total = this.bonusTotal();
      if (this.bonusEaten() >= total) this.finish('perfect');
    }
  }

  bonusTotal() { return this.groups.filter(g => g.counted).reduce((a, g) => a + g.poolSize, 0); }
  bonusEaten() { return this.groups.filter(g => g.counted).reduce((a, g) => a + g.eatenCount, 0); }

  onPlayerGrow() {
    const [sx, sy] = this.toScreen(this.player.x, this.player.y);
    this.splats.spawn('levelUpBurst', sx, sy, null, { layer: 'hud' });
    this.splats.spawn('levelUp', sx, sy - 20, null, { layer: 'hud' });
    this.queueTips('playerGrow');
  }

  onStageGoal() {
    if (this.isBonus || this.isMenu) return;
    this.finish('clear');
  }

  onPlayerKilled() {
    if (this.isMenu) return;
    this.game.state.onDeath(this);
    this.queueTips('playerKilled');
  }

  onPlayerDeathDone() {
    const gs = this.game.state;
    if (this.state !== 'play') return;
    if (gs.mode === 'time' || gs.lives > 0) {
      this.player.spawnPlayer();
      this.player.visibleToFish = true;
    } else {
      this.state = 'gameover';
      this.stateT = 0;
      audio.play('gameOver');
    }
  }

  finish(kind) {
    if (this.state !== 'play') return;
    this.state = 'finish';
    this.finishKind = kind;
    this.stateT = 0;
    this.player.state = 'stageEnd';
    this.player.visibleToFish = false;
    audio.play('stageClear');
    this.addFx('config/fx/stageclearbubbles.xml', VIEW_W / 2, VIEW_H / 2 + 60, { layer: 'hud', autoStop: 2 });
    // scare the fish away
    for (const f of this.fish) {
      if (!f.alive || f.cls === 'Oyster') continue;
      f.state = 'run'; f.target = this.player; f.stateT = 99;
    }
    if (kind === 'clear' && this.game.state.mode === 'normal') this.spawnMermaid();
  }

  spawnMermaid() {
    const def = FishDef.get('config/fish/mermaid.xml');
    if (!def || !def.anims.swim.length) return;
    const m = new Fish(def, this, null);
    const fromLeft = this.player.x > this.width / 2;
    m.spawn({ fromLeft, y: clamp(this.player.y - 40, 120, this.height - 60) });
    m.state = 'chase'; m.target = this.player; m.stateT = 99; m.moveT = 99;
    m.maxX = 200;
    m.isMermaid = true;
    this.fish.push(m);
    audio.play('mermaid');
  }

  // --------------------------------------------------------------- update --
  update(dt) {
    this.elapsed += dt;
    this.stateT += dt;
    const p = this.player;

    if (this.state === 'play' && !this.isMenu) {
      if (this.timeLimit > 0 || this.game.state.mode === 'time') {
        const prev = this.time;
        this.time -= dt;
        if (this.hud && prev > 10 && this.time <= 10 && (this.isBonus || this.game.state.mode === 'time')) this.hud.timeWarning();
        if (this.time <= 0) {
          this.time = 0;
          if (this.isBonus) this.finish('timeup');
          else if (this.game.state.mode === 'time') { this.state = 'gameover'; this.stateT = 0; this.timeUp = true; audio.play('gameOver'); }
        }
      }
    }

    p.inputX = this.game.input.moveX;
    p.inputY = this.game.input.moveY;
    p.sensitivity = this.game.options.sensitivity;
    if (this.game.input.consumeDash() && this.state === 'play') p.dash();
    p.update(dt);

    for (const f of this.fish) { f.update(dt); f.lateUpdate(dt); }
    this.collide();
    this.fish = this.fish.filter(f => f.alive);
    this.updateSpawns(dt);

    for (const ps of this.fx) {
      if (ps.follow) {
        if (!ps.follow.alive && !ps.follow.isPlayer) ps.stop();
        ps.x = ps.follow.x; ps.y = ps.follow.y + ps.dy;
      }
      ps.update(dt);
    }
    this.fx = this.fx.filter(ps => !ps.dead);
    this.splats.update(dt);
    for (const d of this.danger) d.t -= dt;
    this.danger = this.danger.filter(d => d.t > 0);
    for (const l of [this.bg, this.mg, this.fg]) if (l) l.update(dt);

    this.updateCamera(dt);
    if (this.hud) this.hud.update(dt);

    if (this.state === 'finish') {
      const hold = this.finishKind === 'clear' && this.game.state.mode === 'normal' ? 4 : 3;
      if (this.stateT > hold) this.game.onStageFinished(this);
    } else if (this.state === 'gameover' && this.stateT > 2.5) {
      this.game.onStageGameOver(this);
    }

    // tooltip popups
    if (this.pendingTips.length && this.state === 'play') {
      const t = this.pendingTips[0];
      t.delay -= dt;
      if (t.delay <= 0) { this.pendingTips.shift(); this.game.showTip(t.file); }
    }
  }

  collide() {
    const p = this.player;
    const pAlive = p.alive && p.state !== 'dead';
    for (const f of this.fish) {
      if (!f.alive || f.eatenBy) continue;
      if (pAlive && this.state === 'play') {
        const body = p.bodyRect();
        const fBody = f.bodyRect();
        if (f.isMermaid) continue;
        if (f.cls === 'BasicJellyFish') {
          if (rectsHit(body, fBody)) p.stunPlayer(1.5);
          continue;
        }
        if (f.cls === 'Mine') {
          if (!f.exploding && rectsHit(body, f.mouthRect())) {
            f.explode(true);
            if (p.invulnT <= 0 && p.furyT <= 0) {
              if (p.shield > 0) p.hitBy({ size: Infinity });
              else p.die(null);
            }
          }
          continue;
        }
        if (f.puffed && rectsHit(body, fBody)) { p.bounceFrom(f); continue; }
        if (p.state === 'swim' && p.tryEat(f)) continue;
        if (f.canEat(p) && rectsHit(f.mouthRect(), body)) { p.hitBy(f); continue; }
      }
      // enemy predators snack on their chase targets
      if (f.state === 'chase' && f.target && !f.target.isPlayer && f.target.alive && f.canEat(f.target)) {
        if (rectsHit(f.mouthRect(), f.target.bodyRect())) {
          const prey = f.target;
          prey.alive = false; prey.eatenBy = f;
          f.play('eat', true);
          f.toWander();
          if (this.onScreen(prey)) { audio.play('eatenSound', { vol: 0.5 }); this.chompSplat(prey); }
        }
      }
    }
  }

  updateCamera(dt) {
    const p = this.player;
    const tx = clamp(p.x - VIEW_W / 2, 0, Math.max(0, this.width - VIEW_W));
    // leave room for the HUD bar: the playfield below it is centred on the fish
    const ty = clamp(p.y - (VIEW_H + HUD_H) / 2, 0, Math.max(0, this.height - VIEW_H));
    if (this.isMenu) { this.cam.x = tx; this.cam.y = ty; return; }
    const k = 1 - Math.pow(0.0008, dt);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    if (!this.camInit) { this.cam.x = tx; this.cam.y = ty; this.camInit = true; }
  }

  // ----------------------------------------------------------------- draw --
  drawLayer(ctx, l) {
    if (!l) return;
    ctx.save();
    ctx.translate(-Math.round(this.cam.x * l.parallax.x), -Math.round(this.cam.y * l.parallax.y));
    l.draw(ctx);
    ctx.restore();
  }

  draw(ctx) {
    ctx.fillStyle = '#0a3a5a';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    this.drawLayer(ctx, this.bg);
    ctx.save();
    ctx.translate(-Math.round(this.cam.x), -Math.round(this.cam.y));
    for (const f of this.fish) if (f.def.layer === 'mg') f.draw(ctx);
    ctx.restore();
    this.drawLayer(ctx, this.mg);
    ctx.save();
    ctx.translate(-Math.round(this.cam.x), -Math.round(this.cam.y));
    for (const f of this.fish) if (f.def.layer !== 'mg' && !f.isMermaid) f.draw(ctx);
    this.player.draw(ctx);
    for (const f of this.fish) if (f.isMermaid) f.draw(ctx);
    for (const ps of this.fx) if (ps.layer === 'world') ps.draw(ctx);
    this.splats.draw(ctx, 'world');
    if (this.game.debug) this.drawDebug(ctx);
    ctx.restore();
    this.drawLayer(ctx, this.fg);
    this.drawDanger(ctx);
    if (this.hud) this.hud.draw(ctx);
    for (const ps of this.fx) if (ps.layer === 'hud') ps.draw(ctx);
    this.splats.draw(ctx, 'hud');
    this.drawStateText(ctx);
  }

  drawDanger(ctx) {
    const img = assets.image('resources/hud/dangersign.png');
    if (!img) return;
    for (const d of this.danger) {
      if (Math.floor(d.t * 6) % 2) continue;
      const [, sy] = this.toScreen(0, d.f.y);
      const x = d.f.dir > 0 ? 10 : VIEW_W - img.w - 10;
      ctx.drawImage(img.img, x, clamp(sy - img.h / 2, HUD_H + 4, VIEW_H - img.h - 4));
    }
  }

  drawStateText(ctx) {
    let text = null;
    if (this.state === 'finish') text = { clear: 'STAGE CLEAR!', perfect: 'PERFECT!', timeup: 'TIME UP!' }[this.finishKind];
    else if (this.state === 'gameover') text = this.timeUp ? 'TIME UP!' : 'GAME OVER';
    if (!text) return;
    const s = Math.min(1.4, 0.5 + this.stateT * 2);
    ctx.save();
    ctx.translate(VIEW_W / 2, VIEW_H / 2);
    ctx.scale(s, s);
    const m = this.frenzyFont.measure(text);
    this.frenzyFont.draw(ctx, text, 0, -m.h / 2, 'center');
    ctx.restore();
  }

  drawDebug(ctx) {
    const rect = (r, c) => { ctx.strokeStyle = c; ctx.strokeRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1); };
    for (const f of this.fish) { rect(f.bodyRect(), 'lime'); rect(f.mouthRect(), 'red'); }
    if (this.player.alive) { rect(this.player.bodyRect(), 'cyan'); rect(this.player.mouthRect(), 'yellow'); }
  }

  destroy() {
    audio.stopAllLoops();
  }
}

// ------------------------------------------------------------------ HUD ----

class Hud {
  constructor(stage) {
    this.stage = stage;
    this.screen = new Screen('config/gamehud.xml');
    const s = this.screen;
    this.scoreText = s.find('scoreText');
    this.lifeText = s.find('lifeCountText');
    this.frenzyText = s.find('frenzyText');
    this.frenzyText2 = s.find('frenzyText2x');
    this.frenzyMult = s.find('frenzyMultText');
    this.timerText = s.find('timerText');
    this.counterText = s.find('counterText');
    const mode = stage.game.state.mode;
    s.show('timerGroup', stage.isBonus || mode === 'time');
    s.show('counterGroup', stage.isBonus);
    s.show('hudLifePlug', mode === 'time');
    this.bonus2x = s.find('bonusBubble2X');
    this.bonusSpeed = s.find('bonusBubbleSpeed');
    this.marker = assets.image('resources/hud/growmetermarker.png');
    this.warnT = 0;
    // menu images: the first four counted, displayable species
    this.menu = [];
    const seen = new Set();
    for (const g of stage.groups) {
      if (!g.displayMenu || !g.counted || g.def.isHazard) continue;
      if (/bonus/i.test(g.def.cls) || g.def.cls === 'Oyster' || g.def.cls === 'Mine' || g.def.cls === 'BasicJellyFish') continue;
      const key = g.def.animPath + '|' + g.def.size;
      if (seen.has(key)) continue;
      seen.add(key);
      this.menu.push(g);
    }
    this.menu.sort((a, b) => a.def.size - b.def.size);
    this.menu = this.menu.slice(0, 4);
    stage.menuGroups = this.menu;
    for (let i = 0; i < 4; i++) {
      const b = s.find('menuBubble' + i);
      if (b) b.visible = i < this.menu.length;
    }
  }

  timeWarning() {
    this.stage.splats.spawn('timeWarning', 330, 458, null, { layer: 'hud' });
    audio.play('timerWarning');
  }

  update(dt) {
    const st = this.stage, p = st.player, gs = st.game.state;
    this.scoreText.text = fmtScore(gs.score);
    this.lifeText.text = String(Math.min(99, gs.lives)).padStart(2, '0');
    const f = p.frenzy;
    this.frenzyText.maxChars = Math.min(7, f);
    this.frenzyText2.maxChars = Math.max(0, f - 7);
    this.frenzyText.visible = f > 0;
    this.frenzyText2.visible = f > 7;
    this.frenzyMult.text = p.frenzyMult + 'X';
    this.frenzyMult.visible = p.frenzyMult > 1;
    this.timerText.text = fmtTime(st.time);
    if (st.isBonus) this.counterText.text = String(st.bonusEaten()).padStart(2, '0') + '                 ' + String(st.bonusTotal()).padStart(2, '0');
    this.bonus2x.visible = p.bonusT > 0 && (p.bonusT > 1.2 || Math.floor(p.bonusT * 8) % 2 === 0);
    this.bonusSpeed.visible = p.speedT > 0 && (p.speedT > 1.2 || Math.floor(p.speedT * 8) % 2 === 0);
    this.screen.update(dt);
  }

  draw(ctx) {
    const st = this.stage, p = st.player;
    this.screen.draw(ctx);
    // menu fish icons (bright when edible at the current size)
    const g0 = this.screen.find('menuImages');
    for (let i = 0; i < this.menu.length; i++) {
      const slot = this.screen.find('menuBubble' + i);
      const def = this.menu[i].def;
      const img = def.menuOn;
      if (!slot || !img) continue;
      const x = g0.x + slot.x, y = g0.y + slot.y;
      const edible = p.size > def.size;
      ctx.globalAlpha = edible ? 1 : 0.35;
      let im = def.hsv ? assets.hsv(img, def.hsv[0], def.hsv[1], def.hsv[2]) : img;
      const sc = Math.min(1, 44 / im.w);
      ctx.drawImage(im.img, x - im.w * sc / 2, y - im.h * sc / 2, im.w * sc, im.h * sc);
      ctx.globalAlpha = 1;
    }
    // growth meter (created in code at 79,58)
    const gx = 79, gy = 57, gw = 238, gh = 9;
    const frac = p.growthFraction();
    const grad = ctx.createLinearGradient(0, gy, 0, gy + gh);
    grad.addColorStop(0, '#fff3a0'); grad.addColorStop(0.5, '#ffb52e'); grad.addColorStop(1, '#d8661a');
    ctx.fillStyle = grad;
    ctx.fillRect(gx, gy, gw * frac, gh);
    const last = p.sizes[p.sizes.length - 1].targetScore || 1;
    if (this.marker) {
      for (let i = 1; i < p.sizes.length - 1; i++) {
        const mx = gx + gw * clamp(p.sizes[i].targetScore / last, 0, 1);
        ctx.drawImage(this.marker.img, mx - this.marker.w / 2, gy - 3);
      }
    }
    // ability meter: shows the active timed power-up (speed / 2X / fury / shield)
    const ax = 435, ay = 62, aw = 102, ah = 8;
    let af = 0;
    if (p.furyT > 0) af = p.furyT / 4;
    else if (p.speedT > 0) af = p.speedT / 4;
    else if (p.bonusT > 0) af = p.bonusT / 5;
    else if (p.shield > 0) af = 1;
    if (af > 0) {
      ctx.fillStyle = p.shield > 0 && !p.furyT && !p.speedT && !p.bonusT ? '#6fd3ff' : '#7dff6a';
      ctx.fillRect(ax, ay, aw * clamp(af, 0, 1), ah);
    }
  }
}

export { HUD_H };
