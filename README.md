# ffrecomp — Feeding Frenzy for the web

A reverse-engineered port of **Feeding Frenzy** (Sprout Games, 2004) to
HTML5/JavaScript. It runs in any modern browser on desktop, tablet or phone,
with mouse, touch, keyboard or gamepad controls.

The repository contains **only original code and tooling**. All graphics, sound
and level data are extracted at build time from your own copy of the game's
installer (`FeedingFrenzySetup.exe`) and are never committed (`web/game/` is
git-ignored).

## How it works

1. `tools/extract_assets.py` unwraps the installer: GameHouse stub → Inno Setup
   5.1.7 → `FFArchive.saf` (Sprout's archive format). It then merges each JPEG
   colour sprite with its alpha-mask PNG, converts ADPCM and MP3-in-WAV audio,
   and writes `web/game/` plus a `manifest.json` that bundles every XML config file.
2. `web/js/` reimplements the game's *FishFood* engine, using behaviour and
   constants recovered from the original binary with Ghidra and radare2 (see
   [`docs/RE-NOTES.md`](docs/RE-NOTES.md)). The engine reads the original data files
   (screens, stages, fish, FX, fonts), so the levels are the real ones.

The DRM-encrypted part of the executable is neither needed nor touched. Only
the plaintext game code was studied.

## Build and run

```sh
sudo apt install innoextract          # or: brew install innoextract
pip install pillow
python3 tools/extract_assets.py /path/to/FeedingFrenzySetup.exe
cd web && python3 -m http.server 8000  # any static file server works
# open http://localhost:8000
```

To play on a phone, serve `web/` over HTTPS (any static host) or on your LAN,
then use "Add to Home Screen" to install it as a full-screen app (it works
offline once cached). Only deploy the build privately, because it contains the
publisher's copyrighted data.

## Controls

| | Desktop | Touch |
|---|---|---|
| Steer | Fish swims toward the mouse cursor (as in the original) · arrows/WASD · gamepad stick | Touch and hold: the fish swims toward your finger (a joystick mode is available in Options) |
| Dash | Click · Space · gamepad A | **DASH** button, or tap with a second finger |
| Pause | P / Esc · on-screen ⏸ | on-screen ⏸ |

## Debug helpers

* `#stage=N` in the URL jumps straight into stage N (`#stage=N&time` for Time Attack).
* `#debug` or F2 draws collision (green/cyan) and mouth (red/yellow) rectangles.
* `node tests/smoke.mjs` (Playwright, with the page served on port 8765) loads
  every stage, simulates 6 s of play in each, and reports any errors.

## Layout

```
tools/extract_assets.py   installer → web/game/ build step
tools/ghidra/             headless Ghidra scripts used for decompilation
docs/RE-NOTES.md          reverse-engineering findings
web/                      the web app (index.html, js/, css/, sw.js)
tests/smoke.mjs           headless smoke test
```
