'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SessionStore } = require('../src/session-store.cjs');
const id = '00000000-0000-0000-0000-000000000001';
const event = (type, payload) => JSON.stringify({ type, timestamp: '2026-10-15T01:00:00Z', payload }) + '\n';
const total = n => ({ input_tokens: n, output_tokens: 10, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: n + 10 });
const tokens = n => event('event_msg', { type: 'token_count', info: { total_token_usage: total(n), last_token_usage: total(n), model_context_window: 258400 },
  rate_limits: { plan_type: 'pro', primary: { used_percent: 25, window_minutes: 10080, resets_at: 1792000000 }, secondary: null } });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-stats-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), directory = path.join(root, 'cache');
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  const file = path.join(home, 'sessions', 'one.jsonl');
  const data = event('session_meta', { id, source: 'desktop' }) + event('response_item', { content: 'PRIVATE_BODY' }) + event('event_msg', { type: 'item_completed', item: { id: 'tool-1', type: 'CommandExecution', command: 'PRIVATE_COMMAND', output: 'PRIVATE_OUTPUT' } }) + tokens(100);
  await fs.writeFile(file, data);
  await fs.utimes(file, new Date('2026-10-15T01:00:00Z'), new Date('2026-10-15T01:00:00Z'));
  const create = () => { const store = new SessionStore(home, { cacheDirectory: directory }); t.after(() => store.stop()); return store; };
  return { home, directory, file, data, create };
}
test('unchanged logs restore equivalent statistics without replaying lines or persisting body', async t => {
  const f = await fixture(t), cold = f.create(); await cold.scan(); await cold.flushCache();
  const expected = cold.snapshot(); cold.stop();
  const warm = f.create(); await warm.scan();
  assert.equal(warm.cacheHits, 1); assert.equal(warm.files.get(f.file).offset, Buffer.byteLength(f.data));
  assert.deepEqual(warm.snapshot().session, expected.session); assert.deepEqual(warm.snapshot().today, expected.today);
  assert.deepEqual(warm.snapshot().quota, expected.quota);
  assert.deepEqual(expected.quota.windows, [{ percent: 25, minutes: 10080, reset: 1792000000000 }]);
  const cache = await fs.readFile(path.join(f.directory, 'statistics-cache.json'), 'utf8');
  assert.equal(cache.includes('PRIVATE_'), false);
  await fs.appendFile(f.file, event('event_msg', { type: 'item_completed', item: { id: 'tool-1', type: 'CommandExecution' } }) + tokens(150)); await warm.scan();
  assert.equal(warm.snapshot().session.totals.input_tokens, 150);
  assert.equal(warm.snapshot().session.toolUsage.total, 1);
});
test('quota uses the newest desktop snapshot and ignores CLI and replayed snapshots', async t => {
  const f = await fixture(t), store = f.create();
  const quotaEvent = (timestamp, percent) => JSON.stringify({ type: 'event_msg', timestamp,
    payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: percent, window_minutes: 300 }, secondary: null } } }) + '\n';
  await fs.writeFile(path.join(f.home, 'sessions', 'desktop.jsonl'),
    event('session_meta', { id: '00000000-0000-0000-0000-000000000002', source: 'vscode' }) +
    quotaEvent('2026-10-15T02:00:00Z', 40) + quotaEvent('2026-10-15T00:00:00Z', 10));
  await fs.writeFile(path.join(f.home, 'sessions', 'cli.jsonl'),
    event('session_meta', { id: '00000000-0000-0000-0000-000000000003', source: 'cli' }) + quotaEvent('2026-10-15T03:00:00Z', 90));
  await store.scan();
  const state = store.snapshot({ pinnedThreadId: id });
  assert.equal(state.session.threadId, id);
  assert.deepEqual(state.quota.windows, [{ percent: 40, minutes: 300, reset: null }]);
});
test('changed, replaced, truncated and partial logs are rebuilt rather than trusted', async t => {
  const f = await fixture(t), cold = f.create(); await cold.scan(); await cold.flushCache(); cold.stop();
  const stat = await fs.stat(f.file);
  await fs.writeFile(f.file, f.data.replace('input_tokens":100', 'input_tokens":200'));
  await fs.utimes(f.file, stat.atime, stat.mtime);
  assert.equal((await fs.stat(f.file)).mtimeMs, stat.mtimeMs);
  const warm = f.create(); await warm.scan(); assert.equal(warm.cacheHits, 0); assert.equal(warm.snapshot().session.totals.input_tokens, 200);
  await fs.writeFile(f.file, event('session_meta', { id, source: 'desktop' }) + tokens(5)); await warm.scan();
  assert.equal(warm.files.get(f.file).accumulator.totals.input_tokens, 5);
  assert.equal(warm.snapshot().session.totals.input_tokens, 200); // Rebuilt file, retained same-chat cumulative history.
  await fs.appendFile(f.file, '{"unfinished":"private'); await warm.scan();
  assert.equal(warm.files.get(f.file).checkpoint(), null);
});
test('corrupt caches fall back to logs, source directories stay isolated, and deleted logs disappear', async t => {
  const f = await fixture(t), cold = f.create(); await cold.scan(); await cold.flushCache(); cold.stop();
  const file = path.join(f.directory, 'statistics-cache.json');
  await fs.writeFile(file, '{bad'); const warm = f.create(); await warm.scan();
  assert.equal(warm.cacheHits, 0); assert.equal(warm.snapshot().session.totals.input_tokens, 100); assert.equal(warm.snapshot().health.cacheError, 'read-error');
  await warm.flushCache(); assert.equal(warm.snapshot().health.cacheError, null); warm.stop();
  const other = new SessionStore(path.join(f.home, 'other'), { cacheDirectory: f.directory }); t.after(() => other.stop()); await other.scan(); assert.equal(other.snapshot().session, null);
  await fs.unlink(f.file); const deleted = f.create(); await deleted.scan(); assert.equal(deleted.snapshot().session, null);
});

test('active turns are never checkpointed and cache write failures do not affect statistics', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.file, event('event_msg', { type: 'task_started', turn_id: 'running' }));
  const active = f.create(); await active.scan(); await active.flushCache();
  assert.equal(active.files.get(f.file).checkpoint(), null); assert.equal(active.snapshot().session.active, true);
  const warm = f.create(); await warm.scan(); assert.equal(warm.cacheHits, 0); assert.equal(warm.snapshot().session.active, true);
  await fs.appendFile(f.file, event('event_msg', { type: 'task_complete', turn_id: 'running', duration_ms: 1000 })); await warm.scan();
  const mock = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  await warm.flushCache(); assert.equal(warm.snapshot().health.cacheError, 'write-error'); assert.equal(warm.snapshot().session.totals.input_tokens, 100);
  mock.mock.restore(); await warm.flushCache(); assert.equal(warm.snapshot().health.cacheError, null);
});
