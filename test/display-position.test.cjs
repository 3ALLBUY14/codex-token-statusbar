'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { anchorPosition, displayPosition, positionPatch, clampBounds, cleanProfiles } = require('../src/display-position.cjs');
const { DEFAULTS, cleanSettings } = require('../src/settings.cjs');
const one = { id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const two = { id: -2, scaleFactor: 1.5, workArea: { x: -1707, y: -200, width: 1707, height: 920 } };
test('display profiles retain separate offsets, cross-screen destinations and survive disabling', () => {
  let value = cleanSettings(positionPatch(DEFAULTS, one, two, { placement: 'bottom-right', offsetX: -80, offsetY: -40 }));
  value = cleanSettings(positionPatch(value, two, two, { placement: 'top-right', offsetX: -20, offsetY: 60 }), value);
  assert.equal(displayPosition(value, one, [one, two]).display.id, two.id);
  assert.equal(displayPosition(value, one, [one, two]).offsetX, -80);
  assert.equal(displayPosition(value, two, [one, two]).offsetY, 60);
  assert.equal(displayPosition({ ...value, rememberDisplayPositions: false }, one, [one, two]).remembered, false);
  const removed = displayPosition(value, one, [one]);
  assert.equal(removed.display.id, one.id); assert.equal(removed.offsetX, 0);
});
test('negative origins, taskbars and 100/125/150/200 percent DIP work areas keep overlay visible', () => {
  for (const scale of [1, 1.25, 1.5, 2]) for (const placement of ['top-right', 'bottom-right', 'bottom-center']) {
    const work = { x: -Math.round(2560 / scale), y: -180, width: Math.round(2560 / scale), height: Math.round(1400 / scale) };
    const size = { width: 600, height: 56 }, anchor = anchorPosition(work, size, placement);
    for (const shift of [-20000, 0, 20000]) {
      const result = clampBounds({ ...size, x: anchor.x + shift, y: anchor.y + shift }, work);
      assert.ok(result.x >= work.x && result.y >= work.y);
      assert.ok(result.x + result.width <= work.x + work.width && result.y + result.height <= work.y + work.height);
    }
  }
  assert.deepEqual(clampBounds({ x: -9999, y: 9999, width: 900, height: 2000 }, two.workArea), { x: -1707, y: -200, width: 900, height: 920 });
});
test('profile validation is bounded and rejects injected properties and invalid coordinates', () => {
  const profile = { hostId: '1', targetId: '-2', placement: 'top-right', offsetX: 1, offsetY: 2, private: 'drop' };
  assert.equal(cleanProfiles([profile, { ...profile, hostId: '__proto__' }]).length, 1);
  assert.equal(cleanProfiles([profile])[0].private, undefined);
  assert.equal(cleanProfiles([{ ...profile, offsetX: Infinity }]).length, 0);
  assert.equal(cleanProfiles(Array.from({ length: 30 }, (_, i) => ({ ...profile, hostId: String(i) }))).length, 16);
});
