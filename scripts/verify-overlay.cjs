'use strict';
// Run with Electron. Uses an isolated profile, synthetic windows, no user settings.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync, spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { OverlayLayer } = require('../src/overlay-layer.cjs');
const { composerPosition } = require('../src/composer-position.cjs');
const helper = path.join(__dirname, '..', 'artifacts', 'native-helper', 'WindowHelper.exe');
const directory = path.join(__dirname, '..', 'artifacts', 'V1.7-overlay-verification');
app.setPath('userData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const handle = win => String(win.getNativeWindowHandle().readBigUInt64LE());
const inspect = (win, competitor) => JSON.parse(spawnSync(helper, ['--once', '--layer-handle', handle(win), '--above-handle', competitor ? handle(competitor) : '0'], { encoding: 'utf8', windowsHide: true }).stdout);
app.whenReady().then(async () => {
  const options = { width: 350, height: 60, x: 80, y: 80, show: false, frame: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true } };
  const overlay = new BrowserWindow(options), competitor = new BrowserWindow(options);
  await overlay.loadURL('data:text/html,<body style="background:%2313161e;color:white">Codex statusbar layer verification</body>');
  await competitor.loadURL('data:text/html,<body style="background:%23303030;color:white">Temporary desktop layer</body>');
  overlay.showInactive(); competitor.showInactive();
  competitor.setAlwaysOnTop(true, 'pop-up-menu'); competitor.moveTop();
  overlay.setAlwaysOnTop(false);
  const before = inspect(overlay, competitor); assert.equal(before.topmost, false); assert.equal(before.competitorAbove, true);
  const layer = new OverlayLayer(); layer.maintain(overlay, { force: true }); await sleep(100);
  const after = inspect(overlay, competitor);
  assert.equal(after.topmost, true); assert.equal(after.competitorAbove, false); assert.equal(after.foreground, before.foreground);
  await sleep(1200); layer.maintain(overlay); const settled = inspect(overlay, competitor); assert.equal(settled.topmost, true);
  competitor.destroy(); overlay.destroy();
  await sleep(1000);
  // Read the actual foreground Codex through the same helper protocol, without focus changes.
  const hostAt = process.argv.indexOf('--host-handle');
  const probe = hostAt >= 0 ? ['--probe-handle', process.argv[hostAt + 1]] : [];
  const geometry = JSON.parse(spawnSync(helper, ['--once', ...probe], { encoding: 'utf8', windowsHide: true }).stdout);
  const report = { restoredNativeTopmost: after.topmost, raisedAboveCompetitor: !after.competitorAbove, foregroundPreserved: before.foreground === after.foreground, desktopAboveAfterRecovery: after.desktopAbove, retainedAfterSettle: settled.topmost, composerDetected: null };
  if (geometry.visible) {
    const composer = await new Promise((resolve, reject) => {
      const child = spawn(helper, ['--title', '--owner', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); let pending = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('composer-probe-timeout')); }, 7000);
      child.stdout.setEncoding('utf8'); child.stdout.on('data', data => {
        pending += data; const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) { const sample = JSON.parse(line); if (sample.handle !== geometry.handle) continue; clearTimeout(timer); child.kill(); resolve(sample.composer); }
      });
      child.stdin.write(JSON.stringify({ handle: geometry.handle, processId: geometry.processId, composer: true }) + '\n');
    });
    report.composerDetected = Boolean(composer);
    if (composer) {
      const dock = composerPosition(geometry, composer, { width: 500, height: 56 }, 56);
      assert.ok(dock); report.composerPlacement = dock.edge;
      report.composerAvoided = dock.edge === 'above' ? dock.y + dock.height <= composer.y : dock.y >= composer.y + composer.height;
      assert.equal(report.composerAvoided, true);
    }
  }
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
