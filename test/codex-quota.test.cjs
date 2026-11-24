'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseOfficialQuota } = require('../src/codex-quota.cjs');

const reset = 1795883138;
const hour = { usedPercent: 8, windowDurationMins: 300, resetsAt: reset };
const week = { usedPercent: 25, windowDurationMins: 10080, resetsAt: reset };

test('official Codex read prefers its named bucket and retains both windows', () => {
  const codex = { planType: 'pro', primary: hour, secondary: week };
  assert.deepEqual(parseOfficialQuota({
    rateLimits: { limitId: 'other', primary: { ...hour, usedPercent: 99 } },
    rateLimitsByLimitId: { codex },
  }, 42), {
    recordedAt: 42, plan: 'pro', name: null, source: 'official',
    windows: [
      { minutes: 300, percent: 8, reset: reset * 1000 },
      { minutes: 10080, percent: 25, reset: reset * 1000 },
    ],
  });
});

test('weekly-only and unavailable official responses never fabricate a five-hour reading', () => {
  const onlyWeek = { limitId: 'codex', primary: week, secondary: null };
  assert.deepEqual(parseOfficialQuota({ rateLimits: onlyWeek }, 42).windows.map(window => window.minutes), [10080]);
  assert.deepEqual(parseOfficialQuota({ rateLimits: { primary: null, secondary: null } }, 42).windows, []);
  assert.equal(parseOfficialQuota({ rateLimits: { ...onlyWeek, limitId: 'other' } }, 42), null);
  assert.equal(parseOfficialQuota({ rateLimits: { primary: { ...week, usedPercent: null } } }, 42), null);
  assert.equal(parseOfficialQuota(null), null);
});
