// WebAudio sound system. Named sounds come from config/gameplaySounds.xml and
// config/globalSounds.xml (name, file, vol, pitch, count = max simultaneous
// voices); music tracks loop on their own gain bus.
import { assets } from './assets.js';
import { normPath, storage } from './util.js';

class Audio {
  constructor() {
    this.ctx = null;
    this.buffers = new Map(); // normalised file -> AudioBuffer
    this.defs = new Map(); // sound name -> {file, vol, pitch, count}
    this.voices = new Map(); // name -> active count
    this.soundOn = storage.get('sound', true);
    this.musicOn = storage.get('music', true);
    this.music = null;
    this.musicFile = null;
    this.loops = new Map();
  }

  init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.sfxGain = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.sfxGain.connect(this.ctx.destination);
    this.musicGain.connect(this.ctx.destination);
    this.musicGain.gain.value = this.musicOn ? 0.55 : 0;
    this.sfxGain.gain.value = this.soundOn ? 1 : 0;
  }

  // iOS/Android require a user gesture before audio can start.
  unlock() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  async loadAll(onProgress) {
    if (!this.ctx) return;
    const entries = Object.entries(assets.manifest.sounds);
    let done = 0;
    await Promise.all(entries.map(async ([key, file]) => {
      try {
        const res = await fetch('game/' + file);
        const data = await res.arrayBuffer();
        const buf = await new Promise((ok, fail) => this.ctx.decodeAudioData(data, ok, fail));
        this.buffers.set(key, buf);
      } catch (e) { console.warn('audio', key, e); }
      done++;
      onProgress && onProgress(done / entries.length);
    }));
  }

  loadDefs(xmlPath) {
    const doc = assets.xml(xmlPath);
    if (!doc) return;
    for (const s of doc.elements('sound')) {
      this.defs.set(s.attr('name'), {
        file: normPath(s.attr('file')),
        vol: s.num('vol', 1),
        pitch: s.num('pitch', 1),
        count: s.num('count', 2),
      });
    }
  }

  // play by definition name ("bite1") or by file path ("resources/sounds/x.wav")
  play(nameOrFile, opts = {}) {
    if (!this.ctx || !this.soundOn) return null;
    let def = this.defs.get(nameOrFile);
    if (!def) def = { file: normPath(nameOrFile), vol: 1, pitch: 1, count: 3 };
    const buf = this.buffers.get(def.file);
    if (!buf) return null;
    const active = this.voices.get(def.file) || 0;
    if (active >= def.count + 1) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (opts.pitch || 1) * def.pitch;
    const g = this.ctx.createGain();
    g.gain.value = (opts.vol ?? 1) * def.vol;
    src.connect(g).connect(this.sfxGain);
    if (opts.loop) src.loop = true;
    src.start();
    this.voices.set(def.file, active + 1);
    src.onended = () => this.voices.set(def.file, Math.max(0, (this.voices.get(def.file) || 1) - 1));
    return src;
  }

  loop(id, nameOrFile, vol = 1) {
    if (this.loops.has(id)) return;
    const src = this.play(nameOrFile, { loop: true, vol });
    if (src) this.loops.set(id, src);
  }
  stopLoop(id) {
    const s = this.loops.get(id);
    if (s) { try { s.stop(); } catch { /* already stopped */ } this.loops.delete(id); }
  }
  stopAllLoops() { for (const id of [...this.loops.keys()]) this.stopLoop(id); }

  playMusic(file) {
    const k = normPath(file);
    if (this.musicFile === k && this.music) return;
    this.stopMusic();
    this.musicFile = k;
    if (!this.ctx) return;
    const buf = this.buffers.get(k);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.musicGain);
    src.start();
    this.music = src;
  }
  stopMusic() {
    if (this.music) { try { this.music.stop(); } catch { /* noop */ } }
    this.music = null;
    this.musicFile = null;
  }

  setSound(on) {
    this.soundOn = on;
    storage.set('sound', on);
    if (this.sfxGain) this.sfxGain.gain.value = on ? 1 : 0;
    if (!on) this.stopAllLoops();
  }
  setMusic(on) {
    this.musicOn = on;
    storage.set('music', on);
    if (this.musicGain) this.musicGain.gain.value = on ? 0.55 : 0;
  }
}

export const audio = new Audio();
