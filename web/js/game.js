// Game flow controller: menus, map, stage start/complete screens, pause, tips,
// game over / continue, high scores and persistent progress (localStorage in
// place of the original's HKCU\Software\GameHouse\FeedingFrenzy registry keys).
import { assets } from './assets.js';
import { audio } from './audio.js';
import { BitmapFont } from './font.js';
import { Screen, ImageNode, TextNode, TextButton, Node } from './scene.js';
import { Stage } from './stage.js';
import { VIEW_W, VIEW_H, fmtScore, fmtTime, parseVec, pick, storage } from './util.js';
import { decodeText as decodeTextSafe } from './xml.js';

const CHAPTER_ACTIONS = { Andy: ['stageChooseAndy'], Leon: ['stageChooseLeon'], Eddie: ['stageChooseEddie', 'stageChooseSpike'], JD: ['stageChooseJD'], Orville: ['stageChooseOrville', 'stageChooseOrca'] };

const RANKS = [
  [100, 'Newbie Nibbler'], [300, 'Bottom Feeder'], [500, 'Shark-bait'], [800, 'Small Fry'], [1000, 'Minnow Muncher'],
  [1250, 'Hungry Hunter'], [1500, 'Persistent Predator'], [2000, 'Greedy Gobbler'], [2500, 'Flounder Pounder'],
  [3000, 'Angler Wrangler'], [3500, 'Marine Masticator'], [4000, 'Sturgeonator'], [4500, 'Gnarly Gnasher'],
  [5000, 'Expert Eater'], [5500, 'Hardcore Hunter'], [6000, 'Crazy Carnivore'], [6500, 'Ferocious Feeder'],
  [7000, 'Divine Diner'], [8000, 'Champion Chomper'], [9000, 'Perfect Predator'], [Infinity, 'Frenzy Fanatic'],
];
export function rankFor(foodBank) {
  const v = foodBank / 1000;
  for (const [lim, name] of RANKS) if (v < lim) return name;
  return RANKS.at(-1)[1];
}

// Game state (FUN_00435a80 & co): lives 3, continues 2, extra life at 6000
class GameState {
  constructor(mode) {
    this.mode = mode; // 'normal' | 'time'
    this.lives = 3;
    this.score = 0;
    this.continues = 2;
    this.nextLife = 6000;
    this.foodBank = storage.get('foodBank', 0);
    this.clock = 0; // Time Attack clock carried between stages
  }
  addScore(points, stage) {
    this.score = Math.max(0, this.score + points);
    if (this.mode !== 'time' && this.score > this.nextLife) {
      this.lives++;
      audio.play('extraLife');
      if (stage && stage.player) stage.bonusText('Extra Life!', stage.player);
      this.nextLife += this.score < 12000 ? 6000 : 12000;
    }
  }
  onDeath() { if (this.mode !== 'time') this.lives = Math.max(0, this.lives - 1); }
  continueGame() { this.continues--; this.lives = 3; }
  save() { storage.set('foodBank', Math.min(10000000, Math.floor(this.foodBank))); }
}

export class Game {
  constructor(input) {
    this.input = input;
    this.options = {
      tips: storage.get('tips', true),
      sensitivity: storage.get('sensitivity', 1),
      mouseSetting: storage.get('mouseSetting', 2),
      touchMode: storage.get('touchMode', 'follow'),
    };
    input.touchMode = this.options.touchMode;
    this.progress = storage.get('progress', { normal: 0, time: 0 });
    this.scores = storage.get('scores', { normal: [], time: [] });
    this.seen = new Set(storage.get('seenTips', []));
    this.debug = /debug/.test(location.hash);
    this.overlays = []; // modal screens drawn over the scene
    this.scene = null; // {update, draw, screen}
    this.paused = false;
    this.state = null;

    const man = assets.xml('config/stages/stagemanifest.xml');
    this.stages = [];
    let chapter = null;
    for (const c of man.elements()) {
      if (c.tag.toLowerCase() === 'fishchange') chapter = c.attr('name');
      if (c.tag.toLowerCase() === 'stage') {
        this.stages.push({ name: c.attr('name'), path: c.attr('path').toLowerCase(), mapPos: parseVec(c.attr('mapPos')), chapter });
      }
    }
    const facts = assets.xml('config/tooltips/funfacts.xml');
    this.facts = facts ? facts.elements('fact').map(f => f.attr('string')) : [];

    input.on('down', (x, y) => this.pointerDown(x, y));
    input.on('move', (x, y) => this.pointerMove(x, y));
    input.on('up', (x, y) => this.pointerUp(x, y));
    input.on('key', (code) => this.key(code));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.autoPause(); });
  }

  // ---------------------------------------------------------------- helpers --
  saveProgress() { storage.set('progress', this.progress); }
  seenTip(file) { return this.seen.has(file.toLowerCase()); }
  markTip(file) { this.seen.add(file.toLowerCase()); storage.set('seenTips', [...this.seen]); }

  topScreen() { return this.overlays.length ? this.overlays[this.overlays.length - 1] : this.scene && this.scene.screen; }

  pointerDown(x, y) {
    const s = this.topScreen();
    if (s && s.pointerDown(x, y)) return true;
    if (this.overlays.length) return true; // modal: swallow
    if (this.scene && this.scene.onPointerDown) return this.scene.onPointerDown(x, y);
    return !(this.scene && this.scene.stage && !this.paused);
  }
  pointerMove(x, y) { const s = this.topScreen(); if (s) s.pointerMove(x, y); }
  pointerUp(x, y) { const s = this.topScreen(); if (s) s.pointerUp(x, y); }

  key(code) {
    if (code === 'KeyP' || code === 'Escape' || code === 'Pause') {
      if (this.scene && this.scene.stage && !this.scene.stage.isMenu) {
        if (this.paused && this.overlays.length && this.overlays.at(-1).isPause) this.resume();
        else if (!this.paused) this.pause();
      }
    }
    if ((code === 'Enter' || code === 'NumpadEnter') && this.overlays.length && this.overlays.at(-1).defaultAction) {
      const o = this.overlays.at(-1);
      o.onAction(o.defaultAction);
    }
    if (code === 'F2') this.debug = !this.debug;
  }

  pushOverlay(screen) { this.overlays.push(screen); screen.pointerMove(this.input.pointer.x, this.input.pointer.y); }
  popOverlay(screen) {
    const i = this.overlays.indexOf(screen);
    if (i >= 0) this.overlays.splice(i, 1);
  }

  setScene(scene) {
    if (this.scene && this.scene.stage && this.scene.stage !== (scene && scene.stage)) this.scene.stage.destroy();
    this.scene = scene;
    this.overlays = [];
    this.paused = false;
    this.input.clearDash();
    this.onSceneChange && this.onSceneChange();
  }

  get playing() { return !!(this.scene && this.scene.stage && !this.scene.stage.isMenu && !this.paused && !this.overlays.length); }

  // ------------------------------------------------------------ main menu --
  mainMenu() {
    audio.stopAllLoops();
    const bg = new Stage(this, 'config/stages/menustage/stage.xml', { demo: true });
    this.state = null;
    bg.start();
    audio.playMusic('resources/music/menumusic.wav');
    const screen = new Screen('config/mainmenu.xml', (a) => this.menuAction(a));
    const logo = new ImageNode('resources/menus/logo.png', 320, 50, 'center');
    screen.children.unshift(logo); logo.parent = screen;
    const newHelp = screen.find('newGameHelper'), timeHelp = screen.find('timedGameHelper');
    if (newHelp) newHelp.visible = false;
    if (timeHelp) timeHelp.visible = false;
    // "Quit" makes no sense in a browser tab: it toggles fullscreen instead
    this.setScene({
      stage: bg, screen,
      update: (dt) => {
        bg.update(dt);
        screen.update(dt);
        const nb = screen.find('newGameBtnImg'), tb = screen.find('timeGameBtnImg');
        if (newHelp) newHelp.visible = !!(nb && nb.hover);
        if (timeHelp) timeHelp.visible = !!(tb && tb.hover);
      },
      draw: (ctx) => { bg.draw(ctx); screen.draw(ctx); this.drawWebHint(ctx); },
    });
  }

  drawWebHint(ctx) {
    const f = BitmapFont.get('resources/menus/infotext14.xml');
    ctx.globalAlpha = 0.75;
    f.draw(ctx, 'Web port - original game by Sprout Games', 8, 462, 'left');
    ctx.globalAlpha = 1;
  }

  menuAction(a) {
    switch (a) {
      case 'newGame': return this.startGame('normal');
      case 'timeGame': return this.startGame('time');
      case 'options': return this.showOptions();
      case 'highScores': return this.showHighScores(null, () => this.mainMenu());
      case 'showCredits': return this.showCredits();
      case 'quit': return this.onQuit && this.onQuit();
      default:
    }
  }

  showCredits() {
    const s = new Screen('config/credits.xml', (a) => { if (a === 'creditsDone') this.mainMenu(); });
    s.defaultAction = 'creditsDone';
    const extra = new TextNode('resources/menus/infotext14.xml',
      'Web port: engine reimplemented in JavaScript from the original\ngame data. Assets are loaded from your own copy of the game.', 320, 352, 'center');
    s.add(extra);
    this.setScene({ screen: s, update: (dt) => s.update(dt), draw: (ctx) => s.draw(ctx) });
  }

  // ------------------------------------------------------------- options --
  showOptions(onDone) {
    const o = this.options;
    const s = new Screen('config/optionscreen.xml', (a, btn) => {
      switch (a) {
        case 'optionToggleSound': audio.setSound(btn.checked); break;
        case 'optionToggleMusic': audio.setMusic(btn.checked); break;
        case 'optionToggleFullScreen': this.onFullscreen && this.onFullscreen(btn.checked); break;
        case 'optionToggleToolTips': o.tips = btn.checked; storage.set('tips', o.tips); if (o.tips) { this.seen.clear(); storage.set('seenTips', []); } break;
        case 'optionMouse1': case 'optionMouse2': case 'optionMouse3': case 'optionMouse4': {
          const n = parseInt(a.slice(-1), 10);
          o.mouseSetting = n;
          o.sensitivity = [0.7, 0.85, 1, 1.2][n - 1];
          storage.set('mouseSetting', n); storage.set('sensitivity', o.sensitivity);
          for (let i = 1; i <= 4; i++) { const c = s.find('Mouse' + i); if (c) c.checked = i === n; }
          break;
        }
        case 'touchMode':
          o.touchMode = o.touchMode === 'follow' ? 'joystick' : 'follow';
          storage.set('touchMode', o.touchMode);
          this.input.touchMode = o.touchMode;
          btn.text = touchLabel();
          break;
        case 'doOptionsDone':
          this.popOverlay(s);
          if (onDone) onDone();
          break;
        default:
      }
    });
    s.defaultAction = 'doOptionsDone';
    const set = (n, v) => { const c = s.find(n); if (c) c.checked = v; };
    set('soundCheck', audio.soundOn);
    set('musicCheck', audio.musicOn);
    set('fullScreenCheck', !!document.fullscreenElement);
    set('toolTipsCheck', o.tips);
    for (let i = 1; i <= 4; i++) set('Mouse' + i, i === o.mouseSetting);
    s.show('soundErrorText', !audio.ctx);
    // web addition: touch steering style
    const touchLabel = () => 'Touch steering: ' + (o.touchMode === 'follow' ? 'follow finger' : 'joystick');
    const popup = s.find('popUp');
    const tb = new TextButton(fakeNode({
      x: 237, y: 300, font: 'resources/menus/infotext14.xml', overFont: 'resources/menus/infotext14.xml',
      overAddColor: '-1.0,0.0,0.0', string: touchLabel(), action: 'touchMode', xAlign: 'center',
      overSound: 'resources/sounds/mouseOver.wav', activeSound: 'resources/sounds/mouseDown.wav',
    }));
    if (popup) { popup.add(tb); s.refreshButtons(); }
    this.pushOverlay(s);
  }

  // ------------------------------------------------------------ new game --
  startGame(mode) {
    this.state = new GameState(mode);
    const reached = this.progress[mode] || 0;
    if (reached >= 8) this.showChooser(mode);
    else { this.stageIndex = 0; this.showMap(); }
  }

  chapterStart(name) {
    return this.stages.findIndex(s => s.chapter === name);
  }

  showChooser(mode) {
    const reached = this.progress[mode] || 0;
    const s = new Screen('config/stagechooser.xml', (a) => {
      if (a === 'hiddenStage') return;
      for (const [chap, acts] of Object.entries(CHAPTER_ACTIONS)) {
        if (acts.includes(a)) { this.stageIndex = Math.max(0, this.chapterStart(chap)); this.showMap(); return; }
      }
      if (a === 'abortNewGame') this.mainMenu();
    });
    // lock chapters that have not been reached yet
    const groups = { Leon: 'leon', Eddie: 'spike', JD: 'jd', Orville: 'orville' };
    for (const [chap, key] of Object.entries(groups)) {
      const start = this.chapterStart(chap);
      const locked = start < 0 || start > reached;
      const btn = s.find(key + 'Button') || s.find((key === 'orville' ? 'orca' : key) + 'Button');
      const hid = s.find(key + 'Hidden');
      if (btn) btn.visible = !locked;
      if (hid) hid.visible = locked;
    }
    s.defaultAction = 'stageChooseAndy';
    const bg = new ImageNode('resources/menus/mainbg.jpg', 0, 0);
    this.setScene({ screen: s, update: (dt) => s.update(dt), draw: (ctx) => { bg.draw(ctx); s.draw(ctx); } });
  }

  showMap() {
    const st = this.stages[this.stageIndex];
    const s = new Screen('config/maplayout.xml', (a) => {
      if (a === 'mapDone') this.showStageStart();
      else if (a === 'abortNewGame') this.mainMenu();
    });
    s.defaultAction = 'mapDone';
    s.setText('nextStageText', 'Next up:\nStage ' + (this.stageIndex + 1) + ': ' + st.name);
    s.show('loadingTextGroup', false);
    s.setText('stageLabel', '');
    // chapter buttons are decoration here; show the reached ones in colour
    const chapters = [['angel', 'Andy'], ['lion', 'Leon'], ['angler', 'Eddie'], ['jd', 'JD'], ['orca', 'Orville']];
    for (const [k, chap] of chapters) {
      const start = this.chapterStart(chap);
      const reached = start >= 0 && start <= this.stageIndex;
      s.show(k + 'Button', false);
      s.show(k + 'DarkImg', !reached);
      s.show(k + 'NormalImg', reached);
    }
    const dots = new MapDots(this, s);
    this.setScene({ screen: s, update: (dt) => { s.update(dt); dots.update(dt); }, draw: (ctx) => { s.draw(ctx); dots.draw(ctx); } });
    audio.playMusic('resources/music/menumusic.wav');
  }

  showStageStart() {
    const st = this.stages[this.stageIndex];
    const base = 'config/stages/' + st.path + '/';
    const s = new Screen(base + 'startscreen.xml', (a) => {
      if (a === 'stageStart') this.playStage();
      else if (a === 'options') this.showOptions();
      else if (a === 'quitGame') this.quitToMenu();
    });
    s.defaultAction = 'stageStart';
    s.setText('title', 'Stage ' + (this.stageIndex + 1) + ': ' + st.name);
    const doc = assets.xml(base + 'stage.xml');
    const t = doc ? parseTimeAttr(doc.attr('time')) : 0;
    const timed = this.state.mode === 'time';
    s.show('TimeObjective', timed);
    s.show('NoTimeObjective', !timed);
    if (timed) {
      s.setText('timeObjectiveLine1Time', fmtClock(t));
      s.setText('timeObjectiveLine2Time', fmtClock(this.state.clock + t));
    }
    if (this.input.usingTouch) adaptTipsForTouch(s);
    this.setScene({ screen: s, update: (dt) => s.update(dt), draw: (ctx) => s.draw(ctx) });
  }

  // ---------------------------------------------------------------- play --
  playStage() {
    const st = this.stages[this.stageIndex];
    const stage = new Stage(this, 'config/stages/' + st.path + '/stage.xml');
    stage.index = this.stageIndex;
    if (this.state.mode === 'time') stage.time = this.state.clock + stage.timeLimit;
    stage.start();
    this.setScene({
      stage,
      screen: null,
      update: (dt) => {
        const p = stage.player;
        const [sx, sy] = stage.toScreen(p.x, p.y);
        this.input.computeMove(sx, sy, this.playing && p.alive);
        if (!this.paused && !this.overlays.length) stage.update(dt);
        for (const o of this.overlays) o.update(dt);
      },
      draw: (ctx) => { stage.draw(ctx); },
    });
  }

  pause() {
    if (this.paused || !this.scene || !this.scene.stage) return;
    this.paused = true;
    const s = new Screen('config/pausescreen.xml', (a) => {
      if (a === 'pauseResume') this.resume();
      else if (a === 'pauseOptions') this.showOptions();
      else if (a === 'pauseQuit') { this.paused = false; this.overlays = []; this.gameOverFlow(); }
    });
    s.isPause = true;
    s.defaultAction = 'pauseResume';
    this.pushOverlay(s);
    this.onPauseChange && this.onPauseChange(true);
  }
  resume() {
    this.overlays = this.overlays.filter(o => !o.isPause);
    this.paused = this.overlays.length > 0 && this.overlays.some(o => o.isTip);
    this.input.clearDash();
    this.onPauseChange && this.onPauseChange(false);
  }
  autoPause() { if (this.playing) this.pause(); }

  showTip(file) {
    if (this.seenTip(file)) return;
    this.markTip(file);
    const s = new Screen(file, (a) => {
      if (a === 'toolTipDone') { this.popOverlay(s); this.input.clearDash(); }
    });
    s.isTip = true;
    s.defaultAction = 'toolTipDone';
    if (this.input.usingTouch) adaptTipsForTouch(s);
    this.pushOverlay(s);
  }

  // ----------------------------------------------------- stage completion --
  onStageFinished(stage) {
    const gs = this.state;
    const st = this.stages[this.stageIndex];
    const timed = gs.mode === 'time';
    let timeBonus = 0, timeLeft = 0;
    if (timed) {
      gs.clock = Math.max(0, stage.time);
    } else if (!stage.isBonus && stage.timeLimit > 0) {
      timeLeft = Math.max(0, stage.timeLimit - stage.elapsed);
      timeBonus = Math.floor(timeLeft) * 50;
    }
    const scoreBefore = gs.score;
    if (timeBonus) gs.addScore(timeBonus);
    gs.save();
    const next = this.stageIndex + 1;
    if (next > (this.progress[gs.mode] || 0)) { this.progress[gs.mode] = Math.min(next, this.stages.length - 1); this.saveProgress(); }

    const base = 'config/stages/' + st.path + '/';
    const path = assets.xml(base + 'completescreen.xml') ? base + 'completescreen.xml' : 'config/stages/stagecompletebase.xml';
    const s = new Screen(path, (a) => {
      if (a === 'nextStage') this.nextStage();
      else if (a === 'options') this.showOptions();
      else if (a === 'quitGame') this.gameOverFlow();
    });
    s.defaultAction = 'nextStage';
    // eaten counts per menu species
    const groups = stage.menuGroups || [];
    for (let i = 0; i < 4; i++) {
      const g = groups[i];
      const holder = s.find('menuImg' + i);
      if (!holder) continue;
      holder.visible = !!g;
      if (!g) continue;
      const img = g.def.menuOn;
      if (img) {
        const n = new ImageNode(g.def.hsv ? assets.hsv(img, ...g.def.hsv) : img, 0, 0, 'center');
        holder.children.unshift(n); n.parent = holder;
      }
      s.setText('menuText' + i, String(g.eatenCount));
    }
    s.setText('menuText4', stage.stars.got + '/' + stage.stars.total);
    s.show('bonusMenuImgTimed', timed);
    s.show('bonusMenuImg', !timed);
    const fb = Math.floor(gs.foodBank);
    s.setText('upperFoodBankText', fmtScore(fb));
    s.setText('bonusFoodBankText', fmtScore(fb) + ' (' + rankFor(fb) + ')');
    s.setText('upperFoodBankCategoryText', rankFor(fb));
    s.setText('upperTimeModeTimeLeft', fmtClock(gs.clock));
    s.setText('TimeModeTimeLeft', fmtClock(gs.clock));
    s.setText('FunFactText', wrapFact(pick(this.facts) || ''));
    const all = ['UpperFoodBankGroup', 'UpperTimeModeGroup', 'BonusCountGroup', 'TimeBonusGroup', 'FunFactGroup', 'TimeModeGroup', 'FoodBankGroup', 'MenuImages'];
    for (const g of all) s.show(g, false);
    if (stage.isBonus) {
      const eaten = stage.bonusEaten(), total = stage.bonusTotal();
      s.setText('congrats', stage.finishKind === 'perfect' ? 'PERFECT!' : 'BONUS STAGE');
      s.setText('bonusRatioText', String(eaten).padStart(2, '0') + ' / ' + String(total).padStart(2, '0'));
      s.setText('bonusPercentText', Math.round(100 * eaten / Math.max(1, total)) + ' %');
      s.show('BonusCountGroup', true);
      s.show('FunFactGroup', true);
      s.show(timed ? 'TimeModeGroup' : 'FoodBankGroup', true);
    } else if (timed) {
      s.show('MenuImages', true); s.show('UpperTimeModeGroup', true); s.show('FunFactGroup', true);
    } else if (timeBonus > 0) {
      s.show('MenuImages', true); s.show('TimeBonusGroup', true); s.show('FoodBankGroup', true);
      s.setText('TimeBonusTimeLeft', fmtClock(timeLeft));
      s.setText('TimeBonusScore', fmtScore(timeBonus));
      s.setText('TimeBonusFinalScore', fmtScore(gs.score));
    } else {
      s.show('MenuImages', true); s.show('UpperFoodBankGroup', true); s.show('FunFactGroup', true);
    }
    void scoreBefore;
    audio.playMusic('resources/music/menumusic.wav');
    this.setScene({ screen: s, update: (dt) => s.update(dt), draw: (ctx) => s.draw(ctx) });
  }

  nextStage() {
    if (this.stageIndex + 1 >= this.stages.length) return this.gameWon();
    this.stageIndex++;
    this.showMap();
  }

  gameWon() {
    const timed = this.state.mode === 'time';
    const s = new Screen('config/gamewon.xml', (a) => { if (a === 'gameWonDone') this.gameOverFlow(true); });
    s.defaultAction = 'gameWonDone';
    s.show('timedMode', timed); s.show('timedHeader', timed); s.show('timedText', timed);
    s.show('helpHeader', !timed); s.show('helpText', !timed);
    this.setScene({ screen: s, update: (dt) => s.update(dt), draw: (ctx) => s.draw(ctx) });
  }

  onStageGameOver(stage) {
    const gs = this.state;
    if (gs.mode === 'normal' && gs.continues > 0) {
      const s = new Screen('config/gameovercontinue.xml', (a) => {
        if (a === 'continueGame') { gs.continueGame(); this.playStage(); }
        else if (a === 'quitGame') this.gameOverFlow();
      });
      s.defaultAction = 'continueGame';
      s.setText('continueCountText', 'Continues Left: ' + gs.continues);
      this.setScene({ screen: s, update: (dt) => s.update(dt), draw: (ctx) => s.draw(ctx) });
    } else {
      const s = new Screen('config/gameover.xml', (a) => { if (a === 'quitGame') this.gameOverFlow(); });
      s.defaultAction = 'quitGame';
      this.setScene({ screen: s, update: (dt) => s.update(dt), draw: (ctx) => s.draw(ctx) });
    }
    void stage;
  }

  quitToMenu() { this.gameOverFlow(); }

  // high score entry -> table -> menu
  gameOverFlow() {
    const gs = this.state;
    if (!gs) return this.mainMenu();
    gs.save();
    this.state = null;
    const list = this.scores[gs.mode] || [];
    const qualifies = gs.score > 0 && (list.length < 10 || gs.score > list[list.length - 1].score);
    if (!qualifies) return this.mainMenu();
    this.enterName(gs.score, (name) => {
      list.push({ name, score: gs.score });
      list.sort((a, b) => b.score - a.score);
      this.scores[gs.mode] = list.slice(0, 10);
      storage.set('scores', this.scores);
      this.showHighScores(gs.mode, () => this.mainMenu());
    });
  }

  enterName(score, done) {
    const s = new Screen('config/highscoreentry.xml', (a) => {
      if (a === 'highScoreEntryDone') { finish(); }
    });
    s.defaultAction = 'highScoreEntryDone';
    s.setText('scoreText', fmtScore(score));
    let name = storage.get('lastName', '');
    s.setText('nameText', name || ' ');
    const finish = () => {
      if (this.onNameInputEnd) this.onNameInputEnd();
      name = (name || 'Player').slice(0, 14);
      storage.set('lastName', name);
      done(name);
    };
    this.setScene({ screen: s, update: (dt) => { s.update(dt); s.setText('nameText', (name || '') + (Math.floor(performance.now() / 400) % 2 ? '_' : ' ')); }, draw: (ctx) => s.draw(ctx) });
    if (this.onNameInput) this.onNameInput(name, (v) => { name = v; }, finish);
  }

  showHighScores(mode, done) {
    let m = mode || 'normal';
    const s = new Screen('config/highscore.xml', (a) => {
      if (a === 'highScoreDone') done();
      else if (a === 'highScoreNextPage' || a === 'highScorePrevPage') { m = m === 'normal' ? 'time' : 'normal'; fill(); }
    });
    s.defaultAction = 'highScoreDone';
    const fill = () => {
      s.setText('modeText', m === 'normal' ? 'Normal Mode' : 'Time Attack');
      const list = this.scores[m] || [];
      for (let i = 0; i < 10; i++) {
        const e = list[i];
        s.setText('scoreName' + i, e ? e.name + ' . . . . . . . . . .'.slice(0, Math.max(0, 22 - e.name.length)) : '- - -');
        s.setText('score' + i, e ? fmtScore(e.score) : '');
      }
      const fb = storage.get('foodBank', 0);
      s.setText('foodBankTotal', fmtScore(fb));
      s.setText('foodBankRank', rankFor(fb));
    };
    fill();
    const bg = new ImageNode('resources/menus/mainbg.jpg', 0, 0);
    const logo = new ImageNode('resources/menus/logo.png', 320, 50, 'center');
    this.setScene({ screen: s, update: (dt) => s.update(dt), draw: (ctx) => { bg.draw(ctx); logo.draw(ctx); s.draw(ctx); } });
  }

  // ---------------------------------------------------------------- frame --
  update(dt) {
    if (this.scene) this.scene.update(dt);
  }

  draw(ctx) {
    if (this.scene) this.scene.draw(ctx);
    if (this.overlays.length) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      for (const o of this.overlays) o.draw(ctx);
    }
  }
}

// ------------------------------------------------------------------ misc ----

// Map screen: stage checkpoints along the route (mapBtn%d in the original)
class MapDots {
  constructor(game, screen) {
    this.game = game;
    this.t = 0;
    this.imgs = {
      on: assets.image('resources/menus/map/checkpointon.png'),
      off: assets.image('resources/menus/map/checkpointoff.png'),
      done: assets.image('resources/menus/map/checkpointchecked.png'),
      high: assets.image('resources/menus/map/checkpointhigh.png'),
    };
    this.screen = screen;
  }
  update(dt) { this.t += dt; }
  draw(ctx) {
    const g = this.game;
    g.stages.forEach((st, i) => {
      const img = i < g.stageIndex ? this.imgs.done : i === g.stageIndex ? (Math.floor(this.t * 3) % 2 ? this.imgs.high : this.imgs.on) : this.imgs.off;
      if (!img) return;
      ctx.drawImage(img.img, st.mapPos[0] - img.w / 2, st.mapPos[1] - img.h / 2);
    });
  }
}

function fakeNode(attrs) {
  return {
    attrs,
    attr(n, d) { return this.attrs[n] ?? d; },
    num(n, d = 0) { const v = parseFloat(this.attrs[n]); return Number.isFinite(v) ? v : d; },
    bool(n, d) { return this.attrs[n] === undefined ? d : /true|1/.test(this.attrs[n]); },
  };
}

function parseTimeAttr(s) {
  if (!s) return 0;
  const [m, sec] = String(s).trim().split(':').map(Number);
  return sec === undefined ? m : m * 60 + sec;
}
function fmtClock(t) {
  t = Math.max(0, Math.ceil(t));
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}

function wrapFact(text, width = 58) {
  const words = decodeTextSafe(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { lines.push(cur.trim()); cur = w; } else cur += ' ' + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.join('\n');
}

// Replace mouse wording in tips when playing with touch
function adaptTipsForTouch(screen) {
  for (const n of screen.findAll(n => n instanceof TextNode)) {
    if (!/mouse/i.test(n.text)) continue;
    n.text = n.text
      .replace(/Use your mouse to steer your fish\s*\n?/i, 'Touch and hold to steer your fish.\n')
      .replace(/Your fish always swims toward the\s*\n?\s*mouse cursor\./i, 'It always swims toward your finger.')
      .replace(/Tap the left mouse button to dash\s*\n?forward with a burst of speed\./i, 'Tap the DASH button (or tap with a\nsecond finger) for a burst of speed.')
      .replace(/mouse cursor/gi, 'finger')
      .replace(/click/gi, 'tap');
  }
}

export { fmtTime, Node };
