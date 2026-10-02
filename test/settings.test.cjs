'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore } = require('../src/settings.cjs');

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-statusbar-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new SettingsStore(directory) };
}

test('settings survive updates and a fresh store', t => {
  const { directory, store } = temporaryStore(t);
  store.update({ placement: 'bottom-right', scale: 1.3, allowDrag: true, offsetX: -1300 });
  store.update({ showToday: true });
  const restored = new SettingsStore(directory);
  assert.equal(restored.value.placement, 'bottom-right');
  assert.equal(restored.value.scale, 1.3);
  assert.equal(restored.value.showToday, true);
  assert.equal(restored.value.allowDrag, true);
  assert.equal(restored.value.offsetX, -1300);
});

test('EXDEV on rename falls back to copying and persists repeated changes', t => {
  const { directory, store } = temporaryStore(t);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('Cross-device rename'), { code: 'EXDEV' }); });
  store.update({ theme: 'light' });
  store.update({ theme: 'dark', offsetY: 40 });
  const restored = new SettingsStore(directory);
  assert.equal(restored.value.theme, 'dark');
  assert.equal(restored.value.offsetY, 40);
  assert.equal(fs.existsSync(store.filename + '.tmp'), false);
});

test('a failed save leaves both committed settings and memory unchanged', t => {
  const { directory, store } = temporaryStore(t);
  store.update({ scale: 1.15 });
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('Cross-device rename'), { code: 'EXDEV' }); });
  t.mock.method(fs, 'copyFileSync', () => { throw Object.assign(new Error('Access denied'), { code: 'EACCES' }); });
  assert.throws(() => store.update({ scale: 1.5 }), { code: 'EACCES' });
  assert.equal(store.value.scale, 1.15);
  assert.equal(new SettingsStore(directory).value.scale, 1.15);
});

test('permission errors on rename remain visible to the caller', t => {
  const { store } = temporaryStore(t);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('Access denied'), { code: 'EPERM' }); });
  assert.throws(() => store.update({ showToday: true }), { code: 'EPERM' });
  assert.equal(store.value.showToday, false);
});
