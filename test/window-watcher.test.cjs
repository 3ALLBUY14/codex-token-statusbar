'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { WindowWatcher, validGeometry } = require('../src/window-watcher.cjs');
function harness(t, exists = true) {
  const children = []; let time = 1000;
  const watcher = new WindowWatcher({ executable: 'helper.exe', script: 'watch.ps1', exists: () => exists, now: () => time, timeoutMs: 100, retryMs: 5, spawnProcess: (file, args, options) => {
    const child = new EventEmitter(); Object.assign(child, { file, args, options, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false });
    child.kill = () => { child.killed = true; child.emit('close'); }; children.push(child); return child;
  } });
  t.after(() => watcher.stop());
  return { watcher, children, advance: amount => { time += amount; } };
}
const geometry = { visible: true, processId: 10, windowCount: 1, handle: 20, x: -1920, y: 0, width: 1920, height: 1080 };
const write = (child, value) => child.stdout.write(JSON.stringify(value) + '\n');
test('title hangs restart only title while fresh geometry continues', t => {
  const { watcher, children, advance } = harness(t); watcher.start();
  const [position, title] = children;
  write(position, geometry); advance(150); write(position, geometry); watcher.check();
  assert.equal(title.killed, true); assert.equal(position.killed, false);
  assert.equal(watcher.status().geometryHealthy, true);
  assert.match(watcher.status().titleError, /标题通道超时/);
});
test('fragmented samples parse correctly and late titles from previous HWND are rejected', t => {
  const { watcher, children } = harness(t), titles = [], samples = [];
  watcher.on('title', value => titles.push(value)); watcher.on('sample', value => samples.push(value)); watcher.start();
  const encoded = JSON.stringify(geometry) + '\n'; children[0].stdout.write(encoded.slice(0, 9)); children[0].stdout.write(encoded.slice(9));
  assert.equal(samples.length, 1);
  write(children[1], { handle: 21, processId: 10, idle: false, documentTitle: 'wrong' });
  assert.equal(titles.some(value => value.documentTitle === 'wrong'), false);
  write(children[1], { handle: 20, processId: 10, idle: false, documentTitle: 'right' });
  assert.equal(titles.at(-1).documentTitle, 'right');
  assert.equal(children[0].options.windowsHide, true);
});
test('repeated native launch failures fall back and stopping cancels restarts', async t => {
  const { watcher, children } = harness(t); watcher.start();
  for (let i = 0; i < 3; i++) { watcher.geometry.kill(); await new Promise(resolve => setTimeout(resolve, 12)); }
  assert.equal(watcher.status().backend, 'powershell');
  assert.equal(children.at(-1).args.includes('-MTA'), true);
  assert.equal(children.find(child => child.args.includes('--title')).killed, true);
  watcher.stop(); const count = children.length; await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(children.length, count);
});
test('missing helper uses compatibility mode and invalid geometry is ignored', t => {
  const { watcher, children } = harness(t, false); watcher.start();
  assert.equal(children.length, 1); assert.equal(watcher.status().backend, 'powershell');
  assert.equal(validGeometry({ ...geometry, width: -1 }), false);
  assert.equal(validGeometry({ ...geometry, processId: '10' }), false);
  assert.equal(validGeometry(geometry), true);
});

test('composer tracking only accepts the current HWND and valid rectangles while enabled', t => {
  const { watcher, children } = harness(t), received = [];
  watcher.on('composer', value => received.push(value)); watcher.start(); write(children[0], geometry);
  const sample = { handle: 20, processId: 10, idle: false, documentTitle: null, composer: { x: 1, y: 2, width: 500, height: 120 } };
  write(children[1], sample); assert.equal(received.length, 0);
  watcher.setComposerTracking(true); write(children[1], sample); assert.equal(received.at(-1).rect.width, 500);
  write(children[1], { ...sample, handle: 21 }); assert.equal(received.length, 1);
  write(children[1], { ...sample, composer: { ...sample.composer, width: Infinity } }); assert.equal(received.at(-1).rect, null);
  write(children[0], { ...geometry, handle: 22 }); write(children[1], sample); assert.equal(received.length, 2);
});
