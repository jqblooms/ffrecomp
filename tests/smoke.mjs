// Headless smoke test: loads every stage, simulates ~6 s of play in each and
// fails on any page error. Serve web/ on port 8765 first:
//   (cd web && python3 -m http.server 8765) & node tests/smoke.mjs
import { chromium } from 'playwright';

const url = process.env.FF_URL || 'http://localhost:8765/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => document.getElementById('loading').hidden, null, { timeout: 120000 });
if (await page.evaluate(() => !document.getElementById('setup').hidden)) {
  console.error('game data missing: run tools/extract_assets.py first');
  process.exit(2);
}
const count = await page.evaluate(() => window.ffgame.stages.length);
for (let i = 0; i < count; i++) {
  const result = await page.evaluate((i) => {
    const g = window.ffgame;
    g.options.tips = false;
    g.startGame('normal');
    g.stageIndex = i;
    g.playStage();
    for (let k = 0; k < 360; k++) g.update(1 / 60);
    const st = g.scene.stage;
    return `${i} ${g.stages[i].path}: ${st.fish.length} fish, state ${st.state}`;
  }, i);
  console.log(result);
}
await browser.close();
if (errors.length) {
  console.error('FAILED:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('OK: all', count, 'stages ran without errors');
