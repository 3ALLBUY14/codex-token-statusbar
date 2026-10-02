'use strict';
const { screen } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { SettingsStore } = require('./settings.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function mouseProbe(from, to = from, drag = false) {
  const start = screen.dipToScreenPoint(from);
  const end = screen.dipToScreenPoint(to);
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'mouse-probe.ps1'), 'utf8');
  const command = `& {\n${source}\n} -StartX ${start.x} -StartY ${start.y} -EndX ${end.x} -EndY ${end.y} -Drag $${drag ? 'true' : 'false'}`;
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Mouse probe failed: ' + errorText)));
  });
  await pause(200);
}

async function checkInteractions({ overlay, settingsWindow, settings, publish, positionOverlay, artifactDirectory }) {
  const previousSettings = { ...settings.value };
  const originalCursor = screen.getCursorScreenPoint();
  const run = script => overlay.webContents.executeJavaScript(script);
  const toggle = () => run("document.querySelector('[data-action=details]').click()");
  const pointOnMetric = async () => {
    const rect = await run("(() => { const r = document.querySelector('.metric:not([hidden])').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
    const bounds = overlay.getBounds();
    return { x: Math.round(bounds.x + rect.x), y: Math.round(bounds.y + rect.y) };
  };
  try {
    if (await run("document.getElementById('details').classList.contains('open')")) await toggle();
    settings.update({ allowDrag: false, placement: 'top-right', offsetX: 0, offsetY: 0 });
    publish(); positionOverlay(); await pause(300);
    const hoverPoint = await pointOnMetric();
    await mouseProbe(hoverPoint, { x: hoverPoint.x + 3, y: hoverPoint.y });
    await pause(650);
    const hover = await run("({ open: document.getElementById('details').classList.contains('open'), opacity: Number(getComputedStyle(document.getElementById('bar')).opacity) })");
    if (hover.open || hover.opacity > .5) throw new Error('Hover should fade the bar without opening details: ' + JSON.stringify({ hover, hoverPoint, cursor: screen.getCursorScreenPoint(), bounds: overlay.getBounds(), dom: await run("({barClass: document.getElementById('bar').className, hovered: [...document.querySelectorAll(':hover')].map(e=>e.id || e.tagName)})") }));
    fs.writeFileSync(path.join(artifactDirectory, 'statusbar-hover.png'), (await overlay.webContents.capturePage()).toPNG());
    await toggle(); await pause(200);
    await mouseProbe(originalCursor);
    const afterLeave = await run("({ open: document.getElementById('details').classList.contains('open'), opacity: Number(getComputedStyle(document.getElementById('bar')).opacity) })");
    if (!afterLeave.open || afterLeave.opacity < .99) throw new Error('Mouse leave changed details state or failed to restore opacity');
    await toggle(); await pause(200);
    if (await run("document.getElementById('details').classList.contains('open')")) throw new Error('C failed to close details');

    let from = await pointOnMetric();
    const disabledBounds = overlay.getBounds();
    await mouseProbe(from, { x: from.x - 100, y: from.y + 80 }, true);
    const stayed = overlay.getBounds();
    if (stayed.x !== disabledBounds.x || stayed.y !== disabledBounds.y) throw new Error('Dragging was possible while disabled');
    await settingsWindow.webContents.executeJavaScript("document.querySelector('[data-setting=allowDrag]').click()");
    await pause(300);
    if (!settings.value.allowDrag) throw new Error('Settings checkbox failed to enable dragging');
    from = await pointOnMetric();
    const before = overlay.getBounds();
    await mouseProbe(from, { x: from.x - 100, y: from.y + 80 }, true);
    const after = overlay.getBounds();
    const restored = new SettingsStore(path.dirname(settings.filename));
    if (Math.abs(after.x - before.x) < 50 || Math.abs(after.y - before.y) < 40) throw new Error('Native mouse drag did not move the bar: ' + JSON.stringify({ before, after, cursor: screen.getCursorScreenPoint(), dom: await run("({allowDrag:snapshot.settings.allowDrag, barClass:document.getElementById('bar').className, dragging:dragPointer, error:dragError})") }));
    if (restored.value.offsetX !== settings.value.offsetX || restored.value.offsetY !== settings.value.offsetY || !restored.value.allowDrag) throw new Error('Dragged position was not saved');
    const savedBounds = { ...after };
    positionOverlay();
    if (overlay.getBounds().x !== savedBounds.x || overlay.getBounds().y !== savedBounds.y) throw new Error('Window following reset dragged position');
    await toggle(); await pause(200);
    if (!await run("document.getElementById('details').classList.contains('open')")) throw new Error('C stopped working when dragging was enabled');
    return { hoverOpensDetails: false, hoverOpacity: hover.opacity, mouseLeaveKeepsDetails: true, cTogglesDetails: true, dragDisabledStayed: true, nativeDragMoved: true, dragPositionSaved: true };
  } finally {
    settings.update(previousSettings);
    publish(); positionOverlay();
    await mouseProbe(originalCursor);
  }
}

module.exports = { checkInteractions };
