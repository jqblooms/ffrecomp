// Boot: canvas scaling, loading, main loop and DOM on-screen controls.
import { assets } from './assets.js';
import { audio } from './audio.js';
import { Game } from './game.js';
import { Input } from './input.js';
import { VIEW_W, VIEW_H } from './util.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });
const $ = (id) => document.getElementById(id);

const view = {
  scale: 1, left: 0, top: 0,
  toGame(cx, cy) {
    const r = canvas.getBoundingClientRect();
    return [(cx - r.left) / r.width * VIEW_W, (cy - r.top) / r.height * VIEW_H];
  },
};

function layout() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const portrait = vh > vw * 1.1;
  // portrait phones: keep room under the game for the touch controls
  const reserve = portrait && isTouch() ? Math.min(160, vh * 0.22) : 0;
  const s = Math.min(vw / VIEW_W, (vh - reserve) / VIEW_H);
  const w = Math.floor(VIEW_W * s), h = Math.floor(VIEW_H * s);
  const left = Math.floor((vw - w) / 2), top = portrait && reserve ? Math.max(0, Math.floor((vh - reserve - h) / 2)) : Math.floor((vh - h) / 2);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.style.left = left + 'px';
  canvas.style.top = top + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  view.scale = canvas.width / VIEW_W;
  view.left = left; view.top = top;
  document.body.classList.toggle('portrait', portrait);
  const ctl = $('controls');
  ctl.style.setProperty('--game-left', left + 'px');
  ctl.style.setProperty('--game-top', top + 'px');
  ctl.style.setProperty('--game-w', w + 'px');
  ctl.style.setProperty('--game-h', h + 'px');
  ctl.classList.toggle('below', !!reserve);
}

function isTouch() { return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window; }

function setProgress(p, label) {
  $('bar').style.width = Math.round(p * 100) + '%';
  if (label) $('loadlabel').textContent = label;
}

async function boot() {
  layout();
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => setTimeout(layout, 200));
  try {
    await assets.loadManifest();
  } catch (e) {
    $('loading').hidden = true;
    $('setup').hidden = false;
    return;
  }
  audio.init();
  setProgress(0, 'Loading graphics...');
  await assets.preloadImages((p) => setProgress(p * 0.8));
  setProgress(0.8, 'Loading sounds...');
  await audio.loadAll((p) => setProgress(0.8 + p * 0.2));
  audio.loadDefs('config/gameplaysounds.xml');
  audio.loadDefs('config/globalsounds.xml');
  $('loading').hidden = true;

  const input = new Input(canvas, view);
  const game = new Game(input);
  window.ffgame = game; // handy for debugging / automated tests
  wireControls(game, input);
  if (/[#&]stage=(\d+)/.test(location.hash)) {
    const n = parseInt(RegExp.$1, 10);
    game.startGame(/time/.test(location.hash) ? 'time' : 'normal');
    game.stageIndex = Math.min(n, game.stages.length - 1);
    game.playStage();
  } else {
    game.mainMenu();
  }

  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    game.update(dt);
    ctx.setTransform(view.scale, 0, 0, view.scale, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    game.draw(ctx);
    updateControls(game, input);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ------------------------------------------------------- DOM controls --

function wireControls(game, input) {
  const dash = $('dashBtn'), pause = $('pauseBtn'), fs = $('fsBtn');
  const press = (el, fn) => {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); audio.unlock(); fn(); el.classList.add('down'); });
    const up = () => el.classList.remove('down');
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('pointercancel', up);
  };
  press(dash, () => { input.dashQueued = true; });
  press(pause, () => { if (game.paused) game.resume(); else game.pause(); });
  press(fs, () => toggleFullscreen());
  game.onFullscreen = (on) => toggleFullscreen(on);
  game.onQuit = () => toggleFullscreen();
  document.addEventListener('fullscreenchange', () => setTimeout(layout, 50));

  // name entry uses a real text field so phone keyboards work
  const box = $('nameBox'), field = $('nameField');
  game.onNameInput = (initial, onChange, onDone) => {
    box.hidden = false;
    field.value = initial;
    field.oninput = () => onChange(field.value.slice(0, 14));
    field.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); onDone(); } };
    $('nameOk').onclick = () => onDone();
    setTimeout(() => field.focus(), 50);
  };
  game.onNameInputEnd = () => { box.hidden = true; field.blur(); };
}

function updateControls(game, input) {
  const playing = !!(game.scene && game.scene.stage && !game.scene.stage.isMenu);
  const touch = input.usingTouch || isTouch();
  $('dashBtn').hidden = !(playing && touch && !game.paused && !game.overlays.length);
  $('pauseBtn').hidden = !playing;
  $('pauseBtn').textContent = game.paused ? '▶' : 'II';
  $('fsBtn').hidden = playing || !document.fullscreenEnabled;
  canvas.style.cursor = playing && game.playing ? 'crosshair' : 'default';
}

async function toggleFullscreen(force) {
  const on = force ?? !document.fullscreenElement;
  try {
    if (on && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    } else if (!on && document.fullscreenElement) {
      await document.exitFullscreen();
    }
  } catch { /* not allowed */ }
  setTimeout(layout, 100);
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
