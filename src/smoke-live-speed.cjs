'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { LiveSpeed } = require('./live-speed.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function checkLiveSpeed({ overlay, win, state, settings, setFixture, artifactDirectory }) {
  const previous = { ...settings.value }, fixture = structuredClone(state), result = {};
  const read = () => overlay.webContents.executeJavaScript(`({ value: document.getElementById('speed').textContent, label: document.getElementById('speed').closest('.metric').querySelector('.k').textContent, detail: document.getElementById('live-speed-detail').textContent, average: document.getElementById('speed-detail').textContent })`);
  try {
    // Exercise the packaged runtime dependency as well as the renderer states.
    let now = 0; const live = new LiveSpeed({ now: () => now }); live.select('fixture');
    const item = (at, insert) => ({ type: 'text', key: { threadId: 'fixture', entityKey: 'turn', itemId: 'message' }, target: { field: 'text' }, edits: [{ at, deleteCount: 0, insert }] });
    live.ingest({ type: 'patches', baseRevision: 0, revision: 1, acceptedTextChanges: [item(0, 'hello world')] });
    now = 1000; live.ingest({ type: 'patches', baseRevision: 1, revision: 2, acceptedTextChanges: [item(11, ' hello world')] });
    assert.ok(live.snapshot().tokensPerSecond > 0); result.packagedTokenizer = true;
    settings.update({ speedMode: 'live', showSpeed: true, dockToComposer: false, hideLabels: false });
    fixture.session.active = true; fixture.liveSpeed = { tokensPerSecond: 42.5, status: 'streaming' };
    setFixture(fixture); await pause(250);
    let rendered = await read(); assert.equal(rendered.value, '~42.5'); assert.equal(rendered.label, '实时估'); assert.ok(rendered.average.includes('28.4'));
    result.liveDisplayed = true;
    if (overlay.isMinimized()) overlay.restore(); overlay.showInactive(); await pause(200);
    fs.writeFileSync(path.join(artifactDirectory, 'live-speed.png'), (await overlay.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    fixture.liveSpeed = { tokensPerSecond: null, status: 'waiting' }; setFixture(fixture); await pause(200);
    rendered = await read(); assert.equal(rendered.value, '等待'); assert.ok(rendered.average.includes('28.4')); result.waitDoesNotShowOldRate = true;
    await win.webContents.executeJavaScript(`document.getElementById('tab-display').click(); const mode=document.getElementById('speed-mode'); mode.value='average'; mode.dispatchEvent(new Event('change',{bubbles:true}));`);
    await pause(300); assert.equal(settings.value.speedMode, 'average');
    rendered = await read(); assert.equal(rendered.value, '~28.4'); assert.equal(rendered.label, '均速'); result.averageMode = true;
    const saved = new (require('./settings.cjs').SettingsStore)(path.dirname(settings.filename));
    assert.equal(saved.value.speedMode, 'average'); result.persisted = true;
    win.reload(); await new Promise(resolve => win.webContents.once('did-finish-load', resolve)); setFixture(fixture); await pause(250);
    assert.equal(await win.webContents.executeJavaScript("document.getElementById('speed-mode').value"), 'average'); result.reloadRestored = true;
    settings.update({ speedMode: 'live' }); fixture.session.active = false; setFixture(fixture); await pause(200);
    rendered = await read(); assert.equal(rendered.value, '~28.4'); assert.equal(rendered.label, '均速'); assert.equal(rendered.detail, '空闲'); result.idleAverage = true;
    fixture.session = null; setFixture(fixture); await pause(200); rendered = await read(); assert.equal(rendered.value, '—'); result.emptyCleared = true;
    return result;
  } finally { settings.update(previous); setFixture(null); await pause(150); }
}
module.exports = { checkLiveSpeed };
