// Unified input: mouse, touch, keyboard and gamepad.
//
// The original (FUN_00410810) steers with input = (cursor - anchor) / 18 per
// axis, zeroed below 0.1, where the anchor is the fish's screen position in
// windowed mode ("your fish always swims toward the mouse cursor"). A tap of
// the mouse button dashes. On touch screens the same rule applies to a held
// finger ("follow" mode), or a virtual joystick can be used instead.
import { VIEW_W, VIEW_H } from './util.js';

const DEADZONE = 0.1;

export class Input {
  constructor(canvas, view) {
    this.canvas = canvas;
    this.view = view; // {toGame(clientX, clientY) -> [x, y]}
    this.pointer = { x: VIEW_W / 2, y: VIEW_H / 2, down: false, inside: false, touch: false };
    this.moveX = 0; this.moveY = 0;
    this.dashQueued = false;
    this.keys = new Set();
    this.touchMode = 'follow'; // 'follow' | 'joystick'
    this.steerTouch = null; // {id, x, y, sx, sy}
    this.listeners = { down: [], move: [], up: [], key: [] };
    this.usingTouch = false;
    this.lastActivity = 0;
    this.bind();
  }

  on(type, fn) { this.listeners[type].push(fn); }
  emit(type, ...a) { for (const fn of this.listeners[type]) if (fn(...a)) return true; return false; }

  bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.pdown(e));
    window.addEventListener('pointermove', (e) => this.pmove(e));
    window.addEventListener('pointerup', (e) => this.pup(e));
    window.addEventListener('pointercancel', (e) => this.pup(e, true));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code === 'KeyZ' || e.code === 'KeyX') { if (!e.repeat) this.dashQueued = true; }
      if (/^Arrow|Space/.test(e.code)) e.preventDefault();
      this.emit('key', e.code, e);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.steerTouch = null; this.pointer.down = false; });
  }

  pdown(e) {
    const [x, y] = this.view.toGame(e.clientX, e.clientY);
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    this.usingTouch = touch;
    this.pointer = { ...this.pointer, x, y, inside: true, touch, down: true, id: e.pointerId };
    this.lastActivity = performance.now();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
    e.preventDefault();
    if (this.emit('down', x, y, e)) return; // consumed by UI
    if (touch) {
      if (!this.steerTouch) this.steerTouch = { id: e.pointerId, x, y, sx: x, sy: y, t: performance.now() };
      else this.dashQueued = true; // second finger dashes
    } else if (e.button === 0 || e.button === 2) {
      this.dashQueued = true;
    }
  }

  pmove(e) {
    const [x, y] = this.view.toGame(e.clientX, e.clientY);
    if (this.steerTouch && this.steerTouch.id === e.pointerId) { this.steerTouch.x = x; this.steerTouch.y = y; }
    if (e.pointerType === 'mouse') {
      this.usingTouch = false;
      this.pointer.x = x; this.pointer.y = y;
      this.pointer.inside = x >= 0 && y >= 0 && x <= VIEW_W && y <= VIEW_H;
    } else if (this.pointer.id === e.pointerId) {
      this.pointer.x = x; this.pointer.y = y;
    }
    this.emit('move', x, y, e);
  }

  pup(e, cancel) {
    const [x, y] = this.view.toGame(e.clientX, e.clientY);
    if (this.steerTouch && this.steerTouch.id === e.pointerId) {
      // a quick tap (short, barely moved) also dashes, like a mouse click
      const st = this.steerTouch;
      if (!cancel && performance.now() - st.t < 180 && Math.hypot(x - st.sx, y - st.sy) < 12 && this.touchMode === 'joystick') this.dashQueued = true;
      this.steerTouch = null;
    }
    if (this.pointer.id === e.pointerId) this.pointer.down = false;
    if (!cancel) this.emit('up', x, y, e);
  }

  consumeDash() { const d = this.dashQueued; this.dashQueued = false; return d; }
  clearDash() { this.dashQueued = false; }

  // fishX/fishY: the player's position on screen (game coordinates)
  computeMove(fishX, fishY, active) {
    let mx = 0, my = 0;
    if (active) {
      if (this.steerTouch) {
        const t = this.steerTouch;
        if (this.touchMode === 'joystick') {
          const dx = t.x - t.sx, dy = t.y - t.sy;
          const k = 1 / 5; // 60 px of stick ≈ full-speed pull
          mx = dx * k; my = dy * k;
        } else {
          mx = (t.x - fishX) / 18; my = (t.y - fishY) / 18;
        }
      } else if (!this.usingTouch && this.pointer.inside && !this.keyboardActive()) {
        mx = (this.pointer.x - fishX) / 18; my = (this.pointer.y - fishY) / 18;
      }
      // keyboard
      const k = this.keys;
      const kx = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
      const ky = (k.has('ArrowDown') || k.has('KeyS') ? 1 : 0) - (k.has('ArrowUp') || k.has('KeyW') ? 1 : 0);
      if (kx || ky) { mx = kx * 7; my = ky * 7; }
      // gamepad
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gp of pads) {
        if (!gp) continue;
        const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
        if (Math.hypot(ax, ay) > 0.2) { mx = ax * 8; my = ay * 8; }
        const btn = gp.buttons[0] && gp.buttons[0].pressed;
        if (btn && !this.padDashHeld) this.dashQueued = true;
        this.padDashHeld = btn;
        const start = gp.buttons[9] && gp.buttons[9].pressed;
        if (start && !this.padStartHeld) this.emit('key', 'Pause');
        this.padStartHeld = start;
        break;
      }
    }
    if (Math.abs(mx) < DEADZONE) mx = 0;
    if (Math.abs(my) < DEADZONE) my = 0;
    // keep extreme cursor distances from producing absurd accelerations
    const m = Math.hypot(mx, my), cap = 12;
    if (m > cap) { mx *= cap / m; my *= cap / m; }
    this.moveX = mx; this.moveY = my;
  }

  keyboardActive() {
    for (const k of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD']) if (this.keys.has(k)) return true;
    return false;
  }
}
