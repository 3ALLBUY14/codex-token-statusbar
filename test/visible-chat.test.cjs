'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { VisibleChat, resolveVisibleSelection } = require('../src/visible-chat.cjs');
const first = '00000000-0000-0000-0000-000000000001';
const second = '00000000-0000-0000-0000-000000000002';
const route = { known: true, threadId: first, ambiguous: false, source: 'desktop-navigation', time: 100 };
const title = { observed: true, indexed: true, ids: [second], changedAt: 200 };

test('a changed title supersedes a stale route; a newer route supersedes a cached title', () => {
  assert.equal(resolveVisibleSelection(route, title, true).threadId, second);
  assert.equal(resolveVisibleSelection(route, title, true).source, 'visible-document-title');
  assert.equal(resolveVisibleSelection({ ...route, time: 300 }, title, true).threadId, first);
});

test('matching IDs keep the route authoritative even for duplicate titles', () => {
  const result = resolveVisibleSelection(route, { ...title, ids: [first, second] }, true);
  assert.equal(result.threadId, first);
  assert.equal(result.ambiguous, false);
  assert.equal(result.source, 'desktop-navigation');
});

test('unique foreground titles identify multiple windows; duplicate or unknown titles never guess', () => {
  const ambiguous = { ...route, threadId: null, ambiguous: true };
  assert.equal(resolveVisibleSelection(ambiguous, title).threadId, second);
  assert.equal(resolveVisibleSelection(ambiguous, { ...title, ids: [first, second] }).ambiguous, true);
  const unknown = resolveVisibleSelection(route, { ...title, ids: [] }, true);
  assert.equal(unknown.threadId, null);
  assert.equal(unknown.viewKnown, true);
  assert.equal(resolveVisibleSelection({ ...route, threadId: null, time: 300 }, title).threadId, null);
});

test('unavailable accessibility or index does not disable a valid route', () => {
  assert.equal(resolveVisibleSelection(route, { ...title, observed: false }).threadId, first);
  assert.equal(resolveVisibleSelection(route, { ...title, indexed: false }).threadId, first);
});

test('title index handles renames, duplicates, incomplete appends and process boundaries', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-title-index-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'session_index.jsonl');
  const record = (id, name) => JSON.stringify({ id, thread_name: name }) + '\n';
  await fs.writeFile(file, record(first, 'same') + record(second, 'same'));
  const visible = new VisibleChat(home);
  t.after(() => visible.stop());
  await visible.scan();
  visible.observe('same', 123, 1000);
  assert.deepEqual(visible.status(123).ids, [first, second]);
  assert.equal(visible.status(456).observed, false);
  const rename = record(second, 'renamed');
  await fs.appendFile(file, rename.slice(0, -1));
  await visible.scan();
  assert.equal(visible.titleForId(second), 'same');
  await fs.appendFile(file, '\n');
  await visible.scan();
  visible.observe('renamed', 123, 1000);
  assert.deepEqual(visible.status(123).ids, [second]);
  await fs.unlink(file);
  await visible.scan();
  assert.equal(visible.status(123).indexed, false);
  assert.equal(visible.titleForId(second), null);
});
