'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { SessionStore } = require('../src/session-store.cjs');
const { SnapshotGuard } = require('../src/ui/snapshot-guard.js');
const { diagnosticState } = require('../src/diagnostics.cjs');
const root = '00000000-0000-0000-0000-000000000001', child = '00000000-0000-0000-0000-000000000002';
const stamp = new Date().toISOString();
const event = (type, payload) => JSON.stringify({ type, timestamp: stamp, payload }) + '\n';
const usage = n => ({ input_tokens: n, output_tokens: 10, cached_input_tokens: 5, reasoning_output_tokens: 2, total_tokens: n + 10 });
const meta = (id, parent) => event('session_meta', { id, source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : 'desktop' });
const response = (thread, id, n, extra = {}) => event('token_usage_record', { thread_id: thread, session_id: thread, response_id: id, turn_id: 'turn', usage: usage(n), ...extra });
async function fixture(t, data) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-response-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); await fs.mkdir(path.join(directory, 'sessions'));
  for (const [name, content] of Object.entries(data)) await fs.writeFile(path.join(directory, 'sessions', name + '.jsonl'), content);
  const store = new SessionStore(directory, { cacheDirectory: path.join(directory, 'cache') }); t.after(() => store.stop()); await store.scan(); return { store, directory };
}
const snapshot = store => store.snapshot({}, { threadId: root, connected: true });
test('response records replace overlapping legacy totals, dedupe copies and expose recorded coverage', async t => {
  const content = meta(root) + event('turn_context', { model: 'test-model' }) + event('event_msg', { type: 'token_count', info: { total_token_usage: usage(300), last_token_usage: usage(300) } }) + response(root, 'r1', 100) + response(root, 'r1', 100) + response(root, 'r2', 200);
  const { store } = await fixture(t, { one: content, copy: content }); const s = snapshot(store);
  assert.equal(s.session.totals.total_tokens, 320); assert.equal(s.session.accounting.requests, 2); assert.equal(s.today.usage.total_tokens, 320);
  assert.equal(s.session.accounting.byModel[0].model, 'test-model'); assert.equal(s.session.accounting.byModel[0].cached_input_tokens, 10);
  assert.equal(s.session.accounting.method, 'response'); assert.equal(s.session.updatedAt, stamp);
  s.session.accounting.byModel[0].model = 'mutated'; assert.equal(snapshot(store).session.accounting.byModel[0].model, 'test-model');
});
test('related child usage is deduped across parent copies and child files without changing current totals', async t => {
  const { store } = await fixture(t, {
    root: meta(root) + response(root, 'main', 100, { model: 'main' }) + response(child, 'child', 200, { session_id: root }),
    child: meta(child, root) + response(child, 'child', 200, { model: 'worker' }),
  }); const s = snapshot(store);
  assert.equal(s.session.totals.total_tokens, 110); assert.equal(s.session.accounting.related.totals.total_tokens, 320);
  assert.equal(s.session.accounting.relatedThreads, 1); assert.equal(s.today.usage.total_tokens, 320);
  assert.equal(s.session.accounting.related.bySource.find(x => x.source === 'subagent').total_tokens, 210);
  assert.ok(s.session.accounting.related.byModel.some(x => x.model === 'worker'));
});
test('conflicting, malformed and incomplete records are visible, never added twice or silently called complete', async t => {
  const { store } = await fixture(t, { one: meta(root) + response(root, 'bad', 100) + response(root, 'bad', 200) + response(root, 'valid', 300, { thread_token_usage: usage(1000) }) + response(root, 'invalid', -1) });
  const s = snapshot(store); assert.equal(s.session.totals.total_tokens, 310); assert.equal(s.session.accounting.requests, 1); assert.equal(s.session.accounting.partial, true); assert.equal(s.today.partial, true);
  assert.equal(diagnosticState({ ...s, runtime: { testMode: true } }).code, 'usage-partial');
  assert.equal([...store.files.values()][0].checkpoint(), null);
});
test('new-format-only logs update incrementally and late legacy events never overwrite response totals', async t => {
  const { store, directory } = await fixture(t, { one: meta(root) + response(root, 'r1', 10) });
  await fs.appendFile(path.join(directory, 'sessions/one.jsonl'), response(root, 'r2', 20) + event('event_msg', { type: 'token_count', info: { total_token_usage: usage(999), last_token_usage: usage(999) } })); await store.scan();
  assert.equal(snapshot(store).session.totals.total_tokens, 50); assert.equal(snapshot(store).session.accounting.requests, 2);
  store.stop(); const fresh = new SessionStore(directory, { cacheDirectory: path.join(directory, 'cache') }); t.after(() => fresh.stop()); await fresh.scan(); assert.equal(snapshot(fresh).session.totals.total_tokens, 50);
});
test('a clean copy cannot hide conflicting response evidence, and disputed model names stay unassigned', async t => {
  const { store } = await fixture(t, {
    a: meta(root) + response(root, 'conflict', 100) + response(root, 'model', 20, { model: 'first' }),
    b: meta(root) + response(root, 'conflict', 100) + response(root, 'conflict', 200) + response(root, 'model', 20, { model: 'second' }),
  }); const report = snapshot(store).session.accounting;
  assert.equal(report.totals.total_tokens, 30); assert.equal(report.requests, 1); assert.equal(report.partial, true);
  assert.equal(report.byModel[0].model, '模型未记录');
});
test('review attribution requires source evidence; missing model names stay unknown', async t => {
  const { store } = await fixture(t, { one: meta(root) + response(root, 'r1', 10, { thread_source: 'auto_review' }) }); const report = snapshot(store).session.accounting;
  assert.equal(report.bySource[0].source, 'review'); assert.equal(report.byModel[0].model, '模型未记录');
});
test('snapshot ordering rejects stale chats, mismatched data, old epochs and duplicate deliveries', () => {
  const guard = new SnapshotGuard(), state = (id, sequence, epoch) => ({ selection: { threadId: id }, session: { threadId: id }, delivery: { sequence, epoch } });
  assert.equal(guard.accept(state(root, 1, 1)), true); assert.equal(guard.accept(state(child, 2, 2)), true);
  assert.equal(guard.accept(state(root, 1, 1)), false); assert.equal(guard.accept(state(root, 3, 2)), false);
  assert.equal(guard.accept({ ...state(child, 3, 2), session: { threadId: root } }), false);
  assert.equal(guard.accept(state(child, 4, 2)), true); assert.equal(guard.accept(state(child, 4, 2)), false);
  assert.equal(guard.accept({ selection: { threadId: null }, session: null, delivery: { sequence: 5, epoch: 3 } }), true);
});
test('diagnostics distinguish missing docking bounds, unavailable logs and recognized chats without usage', () => {
  const state = { runtime: { testMode: true, composerDock: 'waiting' }, settings: { dockToComposer: true, dockTarget: 'titlebar' }, health: {}, selection: { threadId: root, mode: 'following', connected: true } };
  assert.equal(diagnosticState(state).code, 'dock-waiting'); state.settings.dockToComposer = false;
  assert.equal(diagnosticState(state).code, 'waiting-data'); state.health.readErrors = 1; assert.equal(diagnosticState(state).code, 'read-retrying');
});
