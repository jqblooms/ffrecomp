# Feeding Frenzy – reverse-engineering notes

Target: *Feeding Frenzy* (Sprout Games 2004, GameHouse release, engine build
`Release-2.4.2`, project name `FishFood`). These notes record what was recovered
from the original installer and binary, and how each finding maps onto the
JavaScript port in `web/js/`.

No copyrighted data or code is stored in this repository. The build tool
(`tools/extract_assets.py`) regenerates everything from the user's own installer.

## 1. Distribution layers

| Layer | Format | Notes |
|-------|--------|-------|
| `FeedingFrenzySetup.exe` | PE32 stub + overlay | GameHouse downloader stub; overlay = 4 byte tag + real installer |
| inner installer | Inno Setup 5.1.7 | `innoextract` handles it once the stub is stripped |
| `FeedingFrenzy.exe` | Reflexive Arcade launcher | DRM wrapper, **not needed** |
| `FeedingFrenzy.RWG` | PE32, MSVC 7.1 | the real game. `.text` 0x401000‑0x461fff is plaintext (game + engine); 0x462000‑0x49d000 (CRT/libs/entry) is encrypted by the wrapper. The port never needs the encrypted part, and the DRM is not circumvented. |
| `FFArchive.saf` | Sprout archive (`FFAS`) | 1383 files: 351 XML, 1032 images |
| `resources/sounds`, `resources/music` | RIFF WAV | sfx = MS‑ADPCM (+1 IMA‑ADPCM), music = MP3 in RIFF |

### FFAS archive

```
0x00 char[4] "FFAS"
0x04 u32     version (1)
0x08 u32     directory offset
.... file data ....
dir: u32 ?, u8[16] digest, u32 count,
     count × { u32 offset, u32 size, u8[16] digest, u16 nameLen, char name[nameLen] (NUL terminated) }
```

Names are lower-case and use `/`. XML references use mixed case and `\`, so the
loader lower-cases and normalises every path (the original does the same through
its case-insensitive file system).

### Sprites

Every sprite is a colour JPEG plus a same-named, `_`-prefixed 8-bit PNG holding the
alpha plane (`swim_cycle.1.jpg` + `_swim_cycle.1.png`). The build merges them into
an RGBA WebP. Animation frames are `<anim>\<anim>_cycle.<n>.jpg`, `n` starting at 1.
Default sprite orientation faces **left**.

### Bitmap fonts

`<font height ascent gap spaceWidth>` + `<glyph char a b c>` (Windows ABC widths).
Glyphs are packed left to right starting at `x = gap`, stepping `b + gap`; a new row
starts (at `y += height + gap`, first row at `y = gap`) at each `<!-- row -->`
comment or when the next glyph would overflow the atlas. Advance = `a + b + c`.

## 2. Engine architecture (from RTTI, strings and vtables)

* Scene graph of `engine::Object` nodes: `Group`, `Image`, `AnimImage`, `Text`,
  `TextButton`, `ImageButton`, `CheckBox`, `ParticleSystem`, `FadeContainer`,
  `Selector`, `ScreenLayout`, `SplatFactory`.
* Screens are XML `<screen>` documents (see `config/*.xml`); buttons fire named
  actions (`newGame`, `options`, `pauseResume`, …) that the game dispatches.
* `StageMgr` (vtable 0x4a71b0) owns layers: `bgLayout`, `mgLayout` (fish swim in
  front of it), `PlayGroup` with `fishGroupBg/Mg/Fg`, `fgLayout`, `hudOffsetGroup`,
  HUD (`config/gameHud.xml`).
* Fish classes: `FishBase` → `BrineShrimp, AngelFish, SoldierFish, ChaserFish,
  PufferFish, Barracuda, FlyByFish, PoisonMinnow, Mermaid, SuicideFish,
  BasicJellyFish, Mine, Oyster, GoldenMinnow, BonusBubble…`;
  player classes `PlayerFish, JohnDoryPlayer, AnglerPlayer, LionPlayer, PlayerPuffer`.

## 3. Player (PlayerFish vtable 0x4a2920)

Field map (offset → meaning) used below:

| off | meaning |
|-----|---------|
| 0x11c/0x120 | velocity |
| 0x144 / 0x148 | maxSpeedX / maxSpeedY |
| 0x154 | accelRate |
| 0x158 | drag |
| 0x174 | current size |
| 0x2f0 | input acceleration vector |
| 0x304 | fluidDrag |
| 0x314 | poison timer (drag ×0.5 while > 0) |
| 0x330 / 0x334 | stun timer / post-stun immunity (1.5 s) |
| 0x34c | control-reverse timer (input × −0.7) |
| 0x368 / 0x36c | 2X bonus timer / score multiplier |
| 0x370 / 0x374 | speed-bonus timer / speed multiplier |
| 0x37c | growth points |
| 0x388 | state: 0 swim, 1 growing, 2 being eaten, 3 dead, 4 spawning, 5 stage end, 6 feeding fury, 7 stunned-ish |
| 0x3a0 | size table `{size, scale, targetScore}` |
| 0x3c0 / 0x3c4 / 0x3c8 | frenzy count / frenzy timer / `frenzyTime` |
| 0x3cc | frenzy multiplier |
| 0x3d0 | pending score pop-ups (drained every 0.05 s) |
| 0x3e4 | shield charges (max 1) |

### Input (FUN_00410810)
The cursor is **re-centred every frame** (to 325,265) and the mouse delta is used
as a joystick: `input = delta / 18`, each axis zeroed below 0.1. When reversed
(poison): `input *= −0.7`. The port reproduces this with Pointer Lock on desktop
and a virtual trackpad (finger drag delta) on touch.

### Movement (FUN_00410600)
```
if !stunned: v += input * accelRate * dt
dragAmt = |v|² · fluidDrag · sensitivity + drag      (poisoned: ×0.5)
v -= normalize(v) · min(|v|, dragAmt)
clamp |v| ≤ maxSpeedX · sensitivity
pos += v · dt ; clamp to stage bounds (FUN_0040fc80)
```
Facing flips when `vx > 15` or `vx < −15` (turn animation). Swim animation when
`|v| > 10`, idle otherwise (FUN_00406400).

### Dash (FUN_004122c0)
Not available while stunned/eaten/dead/spawning/fury. `v = normalize(v) · max(|v|, maxSpeedX) · 3`,
dash lasts 0.25 s, re-dash lockout 0.4 s.

### Eating (FUN_004153e0 → FUN_00412690 → FUN_00415760)
* A fish can be eaten by anything strictly larger (`size < attacker.size`,
  FUN_0040ffc0). Mouth = `hotSpot` rect, body = `collision` rect.
* Shield absorbs one hit; the attacker is ignored for 1.6 s afterwards.
* On eat: frenzy += 1 (FUN_00412540), score `+= foodValue × frenzyMult × bonusMult`,
  growth points `+= foodValue × bonusMult`.
* Bonus bubbles: `2X` → bonusMult 2 for 5 s; `Speed` → max speeds ×1.8 for 4 s;
  `FreeLife` → +1 life; `FeedingFury` → fury state; `Stun` → every on-screen fish
  stunned 2.5 s; `Shield` → +1 shield (max 1); `Star` → star pickup;
  Oyster pearl (value 2 = black pearl) → extra life; `GoldenMinnow` → size-table bonus.
* School bonus: 500 points.

### Frenzy (FUN_00412540 / update FUN_00411570)
```
count = min(count + n, 14)
timer = frenzyTime × (count % 7 == 0 ? 1.5 : 1)
mult  = count / 7 + 1      → 2 = "FEEDING FRENZY!", 3 = "DOUBLE FRENZY!"
on timer expiry: count -= 1;
    timer = frenzyTime × (count % 7 == 0 ? 1.4 : count < 8 ? 1/3 : 1/4)
```
HUD lights one letter of `FRENZY!` per count (second row in red above 7).

### Growth (FUN_00412cc0)
The stage's `<size size targetScore scale>` list is scanned; the player's level is the
last entry whose `targetScore ≤ growthPoints`. Growing up plays `playerGrow`,
enters state 1 for 0.2 s. Reaching the final entry completes the stage.

## 4. Game state (FUN_00435a80 …)

* New game: lives 3, score 0, continues 2, next extra life at 6000.
* Extra life every 6000 points until 12000, then every 12000 (not in Time Attack).
* Continue: continues −1, lives = 3.
* Death: respawn after the death timer while lives > 0, else game over / continue.

## 5. Enemy AI (FishBase)

Every `sightCheckFreq` (default 0.1 s) each fish tests every other fish and the
player (`canSee`: within `sightDist` and `sightAngle`), then applies its
`<react class reaction reactFreq>` table: `chase` (edible targets), `avoid`/`run`
(larger predators). Movement changes direction on `*MoveChangeFreq`, and the
state machine re-evaluates on `*StateChangeFreq`. Schools use `schoolSize`,
`schoolDist`, `schoolNeighborDist` and the separation/alignment/cohesion multipliers.

## 6. Parallax

Layer scroll factors were not located in the binary. The port derives each layer's
factor from its content extent: `(extent − view) / (stage − view)`, which gives 1:1
for stage-sized layers and faster scrolling for foreground layers that extend past
the stage width (as `fgLayout` files do).

## Tooling used

`innoextract`, radare2, Ghidra 11.4 headless (scripts in `tools/ghidra/`), Python
(pefile, capstone, Pillow).
