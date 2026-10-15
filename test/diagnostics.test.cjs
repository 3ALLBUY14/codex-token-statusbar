'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { newerVersion, versionParts, diagnosticSummary } = require('../src/diagnostics.cjs');
test('release versions compare numeric components and reject non-release text', () => {
  assert.equal(newerVersion('V1.10', 'V1.2'), true);
  assert.equal(newerVersion('V1.2', 'V1.2.0'), false);
  assert.equal(newerVersion('V1', 'V1.2'), false);
  assert.equal(newerVersion('https://other.example', 'V1'), false);
  assert.equal(versionParts('V2-beta'), null);
});
test('copied diagnostics include health but exclude identifying and tool text', () => {
  const state = { runtime: { version: 'V1.2', watcherHealthy: true, path: 'private-path' }, selection: { mode: 'following', title: 'private-title', threadId: 'private-id' }, health: { readErrors: 1, fileCount: 10 }, session: { toolUsage: { total: 5, failed: 1, records: [{ name: 'private-tool' }] } } };
  const report = diagnosticSummary(state, 'win32-x64');
  assert.equal(report.includes('private-'), false);
  assert.equal(JSON.parse(report).logs.readErrors, 1);
  assert.equal(JSON.parse(report).tools.completed, 5);
});
