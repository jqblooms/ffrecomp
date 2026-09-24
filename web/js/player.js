// PlayerFish: behaviour recovered from the PlayerFish vtable (0x4a2920) of
// the original game. See docs/RE-NOTES.md §3 for the formulas.
import { assets } from './assets.js';
import { audio } from './audio.js';
import { Fish, FishDef, rectsHit } from './fish.js';
import { clamp, lerp, parseVec, pick, rand } from './util.js';

const FRENZY_MAX = 14; // two rows of "FRENZY!"

export class Player extends Fish {
  constructor(stage, cfgPath, sizes) {
    const def = FishDef.get(cfgPath);
    super(def, stage, null);
    this.isPlayer = true;
    const doc = assets.xml(cfgPath);
    this.cfg = {
      maxSpeed: doc.num('maxSpeedX', 345),
      maxSpeedY: doc.num('maxSpeedY', 345),
      accelRate: doc.num('accelRate', 550),
      fluidDrag: doc.num('fluidDrag', 0.0001),
      drag: doc.num('drag', 7),
      frenzyTime: doc.num('frenzyTime', 1.1),
      eatFinishFrame: doc.num('eatFinishFrame', 3),
    };
    this.cls = 'PlayerFish';
    this.playerClass = doc.attr('class', 'PlayerFish');
    this.hsv = doc.attr('hsvOffset') ? parseVec(doc.attr('hsvOffset'), [0, 0, 0]) : null;
    this.sizes = sizes.length ? sizes : [{ size: 5, targetScore: 0, scale: 0.5 }];
    this.level = 0;
    this.size = this.sizes[0].size;
    this.scale = this.sizes[0].scale;
    this.scaleFrom = this.scale; this.scaleTo = this.scale; this.growT = 0;
    this.growth = 0; // growth points (0x37c)
    this.frenzy = 0; this.frenzyT = 0; this.frenzyMult = 1;
    this.bonusMult = 1; this.bonusT = 0; // 2X bubble
    this.speedMult = 1; this.speedT = 0;
    this.shield = 0; this.shieldImmuneT = 0; this.shieldIgnore = null;
    this.stunT = 0; this.stunImmuneT = 0;
    this.poisonT = 0;
    this.dashT = 0; this.dashCool = 0; this.dashVx = 0; this.dashVy = 0;
    this.furyT = 0;
    this.invulnT = 0;
    this.state = 'spawn';
    this.deadT = 0;
    this.visibleToFish = true;
    this.inputX = 0; this.inputY = 0;
    this.sensitivity = 1;
  }

  get maxSpeed() { return this.cfg.maxSpeed * this.speedMult; }

  // ------------------------------------------------------------- spawning --
  spawnPlayer() {
    const st = this.stage;
    this.alive = true;
    this.eatenBy = null;
    this.x = st.width / 2;
    this.y = -this.h;
    this.vx = 0; this.vy = 260;
    this.dashVx = this.dashVy = 0;
    this.facing = -1; this.turning = 0;
    this.state = 'spawn';
    this.invulnT = 2.5;
    this.flash = 2.5;
    this.stunT = 0; this.poisonT = 0; this.furyT = 0;
    this.play('swim');
    audio.play('playerSpawn');
  }

  edibleBy(pred) {
    if (!this.alive || this.state === 'dead' || this.state === 'spawn' || this.state === 'stageEnd') return false;
    if (this.invulnT > 0 || this.furyT > 0) return false;
    if (this.shieldImmuneT > 0 && pred === this.shieldIgnore) return false;
    return this.size < pred.size;
  }

  // -------------------------------------------------------------- update --
  update(dt) {
    if (this.state === 'dead') {
      this.deadT -= dt;
      if (this.deadT <= 0) this.stage.onPlayerDeathDone();
      return;
    }
    this.updateAnim(dt);
    this.timers(dt);

    if (this.state === 'spawn') {
      this.vy = Math.max(0, this.vy - 420 * dt);
      this.y += this.vy * dt;
      if (this.y > 140 || this.vy <= 0) this.state = 'swim';
    } else if (this.state === 'stageEnd') {
      this.vx *= 0.95; this.vy *= 0.95;
      this.x += this.vx * dt; this.y += this.vy * dt;
    } else if (this.furyT > 0) {
      this.updateFury(dt);
    } else {
      this.move(dt);
    }
    this.updateFacing();
    this.clampToStage();
  }

  timers(dt) {
    const dec = (k) => { if (this[k] > 0) this[k] = Math.max(0, this[k] - dt); };
    dec('invulnT'); dec('shieldImmuneT'); dec('stunImmuneT'); dec('dashCool');
    if (this.stunT > 0) {
      this.stunT -= dt;
      if (this.stunT <= 0) {
        this.stunImmuneT = 1.5;
        if (this.stunFx) { this.stunFx.stop(); this.stunFx = null; }
      }
    }
    if (this.poisonT > 0) {
      this.poisonT -= dt;
      if (this.poisonT <= 0 && this.poisonFx) { this.poisonFx.stop(); this.poisonFx = null; }
    }
    if (this.dashT > 0) this.dashT -= dt;
    if (this.speedT > 0) {
      this.speedT -= dt;
      if (this.speedT <= 0) { this.speedMult = 1; audio.play('playerSpeedDown'); }
    }
    if (this.bonusT > 0) {
      this.bonusT -= dt;
      if (this.bonusT <= 0) this.bonusMult = 1;
    }
    // frenzy decay (FUN_00411570)
    if (this.frenzyT > 0) {
      this.frenzyT -= dt;
      if (this.frenzyT <= 0 && this.frenzy > 0) {
        this.frenzy--;
        const ft = this.cfg.frenzyTime;
        this.frenzyT = this.frenzy % 7 === 0 ? ft * 1.4 : this.frenzy < 8 ? ft / 3 : ft / 4;
        if (this.frenzy === 0) this.frenzyT = 0;
      }
    }
    this.frenzyMult = Math.floor(this.frenzy / 7) + 1;
    if (this.growT > 0) {
      this.growT -= dt;
      this.scale = lerp(this.scaleTo, this.scaleFrom, clamp(this.growT / 0.5, 0, 1));
    }
    if (this.flash > 0) this.flash -= dt;
  }

  // relative "joystick" movement (FUN_00410810 / FUN_00410600)
  move(dt) {
    let ix = this.inputX, iy = this.inputY;
    if (this.poisonT > 0) { ix *= -0.7; iy *= -0.7; }
    const sens = this.sensitivity;
    if (this.stunT <= 0) {
      this.vx += ix * this.cfg.accelRate * dt;
      this.vy += iy * this.cfg.accelRate * dt;
    }
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > 0) {
      // drag is per-frame in the original (60 Hz); scale by dt*60
      let drag = (sp * sp * this.cfg.fluidDrag * sens + this.cfg.drag) * dt * 60;
      if (this.dashT > 0) drag *= 0.5;
      const ns = Math.max(0, sp - Math.min(sp, drag));
      this.vx *= ns / sp; this.vy *= ns / sp;
    }
    const max = this.maxSpeed * sens;
    const sp2 = Math.hypot(this.vx, this.vy);
    if (sp2 > max) { this.vx *= max / sp2; this.vy *= max / sp2; }
    // dash impulse decays over the dash window
    if (this.dashT > 0) {
      const k = this.dashT / 0.25;
      this.x += this.dashVx * k * dt;
      this.y += this.dashVy * k * dt;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  clampToStage() {
    if (this.state === 'spawn') return;
    const st = this.stage;
    const hw = this.w * 0.35, hh = this.h * 0.35;
    const top = 90 + hh * 0.3;
    if (this.x < hw) { this.x = hw; if (this.vx < 0) this.vx = 0; }
    if (this.x > st.width - hw) { this.x = st.width - hw; if (this.vx > 0) this.vx = 0; }
    if (this.y < top) { this.y = top; if (this.vy < 0) this.vy = 0; }
    if (this.y > st.height - hh) { this.y = st.height - hh; if (this.vy > 0) this.vy = 0; }
  }

  dash() {
    if (this.state !== 'swim' || this.stunT > 0 || this.furyT > 0 || this.dashCool > 0) return false;
    let dx = this.vx, dy = this.vy;
    let m = Math.hypot(dx, dy);
    if (m < 1) { dx = this.facing; dy = 0; m = 1; }
    const sp = Math.max(m, this.cfg.maxSpeed) * 3 * 0.5;
    this.dashVx = dx / m * sp; this.dashVy = dy / m * sp;
    this.dashT = 0.25;
    this.dashCool = 0.4;
    audio.play('playerDash');
    this.stage.addFx('config/fx/dashfx.xml', 0, 0, { follow: this, autoStop: 0.25 });
    return true;
  }

  updateFury(dt) {
    this.furyT -= dt;
    if (this.furyT <= 0) { this.endFury(); return; }
    // home on the nearest edible fish at up to 1600 px/s (FUN_00410a10)
    let best = null, bd = Infinity;
    for (const f of this.stage.fish) {
      if (!f.alive || !this.canEat(f) || f.isBonus) continue;
      if (!this.stage.onScreen(f)) continue;
      const d = Math.hypot(f.x - this.x, f.y - this.y);
      if (d < bd) { bd = d; best = f; }
    }
    if (best) {
      const sp = Math.min(1600, bd / dt);
      this.vx = (best.x - this.x) / bd * Math.min(sp, 900);
      this.vy = (best.y - this.y) / bd * Math.min(sp, 900);
    } else { this.vx *= 0.9; this.vy *= 0.9; this.move(dt); return; }
    this.x += this.vx * dt; this.y += this.vy * dt;
  }

  startFury() {
    if (this.furyT > 0) return;
    this.furyT = 4;
    this.stage.addFx('config/fx/goldentrail.xml', 0, 0, { follow: this, autoStop: 4 });
    audio.play('starPickup');
    audio.play('furyStart');
  }
  endFury() {
    this.furyT = 0;
    audio.play('furyEnd');
  }

  // ------------------------------------------------------------- eating --
  tryEat(f) {
    if (!rectsHit(this.mouthRect(), f.bodyRect())) return false;
    if (f.cls === 'Oyster') {
      if (!f.pearlAvailable || !rectsHit(this.mouthRect(), f.pearlRect())) return false;
      this.eatPearl(f);
      return true;
    }
    if (!this.canEat(f)) return false;
    this.eat(f);
    return true;
  }

  eat(f) {
    f.alive = false;
    f.eatenBy = this;
    this.play('eat', true);
    if (f.def.eatenSound) audio.play(f.def.eatenSound.name, { pitch: f.def.eatenSound.pitch });
    else audio.play('eatenSound');
    if (!f.isBonus) {
      audio.play(pick(['bite1', 'bite2', 'bite3', 'bite4']));
      this.stage.addFx('config/fx/playereatfishfx.xml', this.mouthX(), this.mouthY(), { autoStop: 0.3 });
      this.stage.chompSplat(f);
    } else {
      this.stage.addFx('config/fx/playereatbonusfx.xml', f.x, f.y, { autoStop: 0.3 });
    }
    this.applyBonus(f);
    this.stage.onFishEaten(f);
  }

  mouthX() { const r = this.mouthRect(); return (r.x1 + r.x2) / 2; }
  mouthY() { const r = this.mouthRect(); return (r.y1 + r.y2) / 2; }

  // FUN_00415760
  applyBonus(f) {
    const st = this.stage;
    switch (f.cls) {
      case 'BonusBubble2X':
        this.bonusMult = 2; this.bonusT = 5;
        st.bonusText('2X Bonus!', f);
        return;
      case 'BonusBubbleSpeed':
        if (this.speedMult === 1) this.speedMult = 1.8;
        this.speedT = 4;
        audio.play('playerSpeedUp');
        st.bonusText('Speed Bonus', f);
        return;
      case 'BonusBubbleFreeLife':
        st.addLife(f);
        return;
      case 'BonusBubbleFeedingFury':
        this.startFury();
        return;
      case 'BonusBubbleStun':
        audio.play('stunBubble');
        st.stunAll(2.5);
        st.addFx('config/fx/stunnedeatworldfx.xml', f.x, f.y, { autoStop: 0.5 });
        return;
      case 'BonusBubbleShield':
        this.shield = Math.min(1, this.shield + 1);
        if (!this.shieldFx) this.shieldFx = st.addFx('config/fx/playershieldglow.xml', 0, 0, { follow: this });
        st.bonusText('Shield!', f);
        return;
      case 'BonusBubbleStar':
        st.starCollected(f);
        audio.play('starPickup');
        return;
      default:
    }
    if (f.cls === 'PoisonMinnow') this.poison(5);
    const food = f.def.foodValue;
    if (f.cls === 'GoldenMinnow') st.bonusText('Golden Minnow!', f);
    if (food > 0) this.addGrowth(food * this.bonusMult);
    if (food !== 0) {
      this.addFrenzy(1);
      st.addScore(Math.round(food * this.frenzyMult * this.bonusMult), f);
    }
  }

  eatPearl(oyster) {
    const o = oyster.oyster;
    const type = o.pearl;
    o.pearl = -1;
    audio.play('oysterPearl');
    this.play('eat', true);
    this.stage.addFx('config/fx/oysterpearlfx.xml', oyster.x, oyster.y - 10, { autoStop: 0.4 });
    if (type === 2) this.stage.addLife(oyster);
    else if (type === 1) this.stage.bonusText('Black Pearl!', oyster);
    const food = oyster.def.foodValue * (type === 1 ? 3 : 1);
    this.addGrowth(food * this.bonusMult);
    this.addFrenzy(1);
    this.stage.addScore(Math.round(food * this.frenzyMult * this.bonusMult), oyster);
  }

  addFrenzy(n) {
    const prevMult = Math.floor(this.frenzy / 7) + 1;
    this.frenzy = Math.min(FRENZY_MAX, this.frenzy + n);
    this.frenzyT = this.frenzy % 7 === 0 ? this.cfg.frenzyTime * 1.5 : this.cfg.frenzyTime;
    const mult = Math.floor(this.frenzy / 7) + 1;
    if (mult > prevMult) {
      if (mult === 2) { audio.play('frenzyVox'); audio.play('frenzyChime'); this.stage.frenzySplat(false); }
      if (mult === 3) { audio.play('doubleFrenzyVox'); audio.play('frenzyChime'); this.stage.frenzySplat(true); }
    }
    this.frenzyMult = mult;
  }

  // FUN_00412cc0
  addGrowth(points) {
    this.growth += points;
    let lvl = 0;
    for (let i = 0; i < this.sizes.length; i++) if (this.sizes[i].targetScore <= this.growth) lvl = i;
    if (lvl > this.level) {
      const prevScale = this.scale;
      this.level = lvl;
      this.size = this.sizes[lvl].size;
      if (this.sizes[lvl].scale !== prevScale) {
        this.scaleFrom = prevScale; this.scaleTo = this.sizes[lvl].scale; this.growT = 0.5;
        audio.play('playerGrow');
        this.stage.onPlayerGrow();
      }
      if (lvl === this.sizes.length - 1) this.stage.onStageGoal();
    }
  }

  growthFraction() {
    const last = this.sizes[this.sizes.length - 1].targetScore || 1;
    return clamp(this.growth / last, 0, 1);
  }

  // -------------------------------------------------------------- damage --
  hitBy(pred) {
    if (!this.edibleBy(pred)) return false;
    if (this.shield > 0) {
      this.shield--;
      this.shieldImmuneT = 1.6;
      this.shieldIgnore = pred;
      audio.play('playerLostShield');
      if (this.shieldFx) { this.shieldFx.stop(); this.shieldFx = null; }
      this.flash = 1;
      return false;
    }
    this.die(pred);
    return true;
  }

  die(pred) {
    if (this.state === 'dead') return;
    this.alive = false;
    this.eatenBy = pred || true;
    this.state = 'dead';
    this.deadT = 2.2;
    this.frenzy = 0; this.frenzyT = 0; this.frenzyMult = 1;
    this.furyT = 0;
    this.shield = 0;
    for (const k of ['stunFx', 'poisonFx', 'shieldFx']) if (this[k]) { this[k].stop(); this[k] = null; }
    audio.play('playerDie');
    if (pred && pred.play) { pred.play('eat', true); audio.play(pick(['bite1', 'bite2', 'bite3', 'bite4'])); }
    this.stage.chompSplat(this, true);
    this.stage.onPlayerKilled();
  }

  stunPlayer(t) {
    if (this.stunT > 0 || this.stunImmuneT > 0 || this.invulnT > 0 || this.furyT > 0) return;
    this.stunT = t;
    this.vx *= 0.2; this.vy *= 0.2;
    audio.play('playerStunned');
    if (!this.stunFx) this.stunFx = this.stage.addFx('config/fx/stunnedeffect.xml', 0, 0, { follow: this, dy: -this.h * 0.4 });
  }

  poison(t) {
    if (this.poisonT > 0) return;
    this.poisonT = t;
    audio.play('playerPoisoned');
    this.stage.bonusText('Poisoned!', this, true);
    if (!this.poisonFx) this.poisonFx = this.stage.addFx('config/fx/poisontrailfx.xml', 0, 0, { follow: this });
  }

  bounceFrom(f) {
    const dx = this.x - f.x, dy = this.y - f.y;
    const d = Math.hypot(dx, dy) || 1;
    this.vx = dx / d * 420; this.vy = dy / d * 420;
    this.stunPlayer(0.6);
    audio.play('pufferBounce');
  }

  oysterBite() {
    audio.play('oysterBite');
    this.stunPlayer(1.2);
  }

  draw(ctx) {
    if (!this.alive) return;
    if (this.invulnT > 0 && Math.floor(this.invulnT * 12) % 2) { ctx.globalAlpha = 0.45; super.draw(ctx); ctx.globalAlpha = 1; return; }
    super.draw(ctx);
  }
}

export { rand };
