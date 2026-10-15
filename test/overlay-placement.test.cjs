'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { composerPosition, titlebarPosition } = require('../src/composer-position.cjs');
const { OverlayLayer } = require('../src/overlay-layer.cjs');
const { cleanSettings, DEFAULTS } = require('../src/settings.cjs');
const host = { x: -1000, y: 20, width: 1000, height: 800 };
test('composer docking prefers free space below and avoids the entire composer when space is limited', () => {
  const input = { x: -800, y: 580, width: 600, height: 100 }, size = { width: 500, height: 52 };
  const below = composerPosition(host, input, size, 52);
  assert.equal(below.edge, 'below'); assert.ok(below.y >= input.y + input.height);
  const lower = { ...input, y: 710 }, above = composerPosition(host, lower, size, 52);
  assert.equal(above.edge, 'above'); assert.ok(above.y + above.height <= lower.y);
  const expanded = composerPosition(host, lower, { ...size, height: 550 }, 52);
  assert.equal(expanded.y + expanded.height, above.y + above.height);
  assert.equal(composerPosition(host, { ...input, width: NaN }, size, 52), null);
  assert.equal(composerPosition(host, { ...input, y: 900 }, size, 52), null);
  assert.equal(composerPosition(host, { ...lower, x: -1500 }, size, 52), null);
});
test('expanded panel is bounded by host top and narrow composers constrain width', () => {
  const result = composerPosition(host, { x: -950, y: 710, width: 280, height: 100 }, { width: 600, height: 1600 }, 52);
  assert.equal(result.width, 280); assert.ok(result.y >= host.y); assert.ok(result.height < 1600);
});

test('composer alignment follows input width and stays bounded across scales and expanded sizes', () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const frame = { x: -2000 / scale, y: 0, width: 1600 / scale, height: 1200 / scale };
    for (const inputWidth of [Math.max(220, 320 / scale), 1100 / scale]) {
      const input = { x: frame.x + 30, y: 800 / scale, width: inputWidth, height: 150 / scale };
      for (const alignment of ['left', 'center', 'right']) for (const width of [260 / scale, 600 / scale, 1400 / scale]) {
        const dock = composerPosition(frame, input, { width, height: 400 / scale }, 52 / scale, alignment);
        const expected = alignment === 'left' ? input.x : alignment === 'right' ? input.x + input.width - Math.min(width, input.width) : input.x + (input.width - Math.min(width, input.width)) / 2;
        assert.ok(dock); assert.equal(dock.x, Math.round(expected));
        assert.ok(dock.x >= Math.floor(input.x)); assert.ok(dock.x + dock.width <= Math.ceil(input.x + input.width) + 1);
      }
    }
  }
});

test('composer alignment defaults safely and rejects invalid settings', () => {
  assert.equal(DEFAULTS.composerAlignment, 'center');
  for (const alignment of ['center', 'left', 'right']) assert.equal(cleanSettings({ composerAlignment: alignment }).composerAlignment, alignment);
  assert.equal(cleanSettings({ composerAlignment: 'invalid' }).composerAlignment, 'center');
  assert.equal(cleanSettings({ composerAlignment: null }, { ...DEFAULTS, composerAlignment: 'right' }).composerAlignment, 'right');
});

test('titlebar docking stays inside the safe slot and expands down without moving the bar', () => {
  for (const scale of [1, 1.25, 1.5, 2]) for (const alignment of ['left', 'center', 'right']) {
    const frame = { x: -2000 / scale, y: -100, width: 1800 / scale, height: 1200 / scale };
    const area = { x: frame.x + 400 / scale, y: frame.y + 4, width: 1100 / scale, height: 48 / scale };
    const bar = 28 / scale;
    const closed = titlebarPosition(frame, area, { width: 400 / scale, height: bar }, bar, alignment);
    const open = titlebarPosition(frame, area, { width: 700 / scale, height: 700 / scale }, bar, alignment);
    assert.ok(closed && open); assert.equal(closed.y, open.y);
    assert.ok(closed.y >= area.y && closed.y + bar <= area.y + area.height);
    assert.ok(open.x >= Math.floor(area.x) && open.x + open.width <= Math.ceil(area.x + area.width) + 1);
    assert.ok(open.y + open.height <= frame.y + frame.height);
    assert.equal(open.edge, 'titlebar');
  }
  const area = { x: -700, y: 24, width: 500, height: 32 };
  assert.equal(titlebarPosition(host, area, { width: 400, height: 50 }, 50), null);
  assert.equal(titlebarPosition(host, { ...area, x: -1500 }, { width: 400, height: 28 }, 28), null);
  assert.equal(cleanSettings({ dockTarget: 'titlebar' }).dockTarget, 'titlebar');
  assert.equal(cleanSettings({ dockTarget: 'invalid' }).dockTarget, 'composer');
});
test('layer recovery is throttled, skips hidden/settings windows, and restores normal level when disabled', () => {
  let now = 1000, visible = true; const calls = [];
  const win = { isDestroyed: () => false, isVisible: () => visible, setAlwaysOnTop: (...v) => calls.push(v), moveTop: () => calls.push('raise') };
  const layer = new OverlayLayer(() => now);
  assert.equal(layer.maintain(win), true); assert.equal(layer.maintain(win), false);
  now += 1000; visible = false; assert.equal(layer.maintain(win), false);
  visible = true; assert.equal(layer.maintain(win, { suspended: true }), false);
  assert.equal(calls.length, 2); assert.equal(layer.maintain(win), true);
  layer.maintain(win, { enabled: false }); assert.deepEqual(calls.at(-1), [true, 'floating']);
  assert.ok(!('focus' in win));
});
test('upgrade enables desktop recovery while composer docking remains opt-in', () => {
  assert.equal(cleanSettings({}).desktopCompatibility, true); assert.equal(DEFAULTS.dockToComposer, false);
  assert.equal(cleanSettings({ dockToComposer: 'true' }).dockToComposer, false);
  assert.equal(cleanSettings({ dockToComposer: true }).dockToComposer, true);
});
