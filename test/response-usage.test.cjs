'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { SessionStore } = require('../src/session-store.cjs');
const { SnapshotGuard } = require('../src/ui/snapshot-guard.js');
const { diagnosticState } = require('../src/diagnostics.cjs');
const { localDay } = require('../src/metrics.cjs');
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
  const s = snapshot(store); assert.equal(s.session.totals.total_tokens, 1010); assert.equal(s.session.accounting.recordedTotals.total_tokens, 310); assert.equal(s.session.accounting.unassignedTokens, 700); assert.equal(s.session.accounting.requests, 1); assert.equal(s.session.accounting.partial, true); assert.equal(s.today.partial, true);
  assert.equal(diagnosticState({ ...s, runtime: { testMode: true } }).code, 'usage-history');
  assert.equal([...store.files.values()][0].checkpoint(), null);
});
test('new-format-only logs update incrementally and late legacy events never overwrite response totals', async t => {
  const { store, directory } = await fixture(t, { one: meta(root) + response(root, 'r1', 10) });
  await fs.appendFile(path.join(directory, 'sessions/one.jsonl'), response(root, 'r2', 20) + event('event_msg', { type: 'token_count', info: { total_token_usage: usage(999), last_token_usage: usage(999) } })); await store.scan();
  assert.equal(snapshot(store).session.totals.total_tokens, 1009); assert.equal(snapshot(store).session.accounting.recordedTotals.total_tokens, 50); assert.equal(snapshot(store).session.accounting.requests, 2);
  store.stop(); const fresh = new SessionStore(directory, { cacheDirectory: path.join(directory, 'cache') }); t.after(() => fresh.stop()); await fresh.scan(); assert.equal(snapshot(fresh).session.totals.total_tokens, 1009);
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
test('switching models in one chat preserves cumulative checkpoints and separates unassigned history', async t => {
  const { store, directory } = await fixture(t, { one: meta(root) + event('turn_context', { model: 'model-A' }) + event('event_msg', { type: 'token_count', info: { total_token_usage: usage(1000), last_token_usage: usage(100) } }) + response(root, 'a1', 100, { model: 'model-A', thread_token_usage: usage(1000) }) });
  assert.equal(snapshot(store).session.totals.total_tokens, 1010);
  await fs.appendFile(path.join(directory, 'sessions/one.jsonl'), event('event_msg', { type: 'thread_settings_applied', thread_id: root, thread_settings: { model: 'model-B' } }) + response(root, 'b1', 200, { model: 'model-B', thread_token_usage: { ...usage(1200), output_tokens: 20, total_tokens: 1220 } })); await store.scan();
  const s = snapshot(store); assert.equal(s.session.model, 'model-B'); assert.equal(s.session.totals.total_tokens, 1220);
  assert.equal(s.session.accounting.recordedTotals.total_tokens, 320); assert.equal(s.session.accounting.unassignedTokens, 900);
  assert.equal(s.session.accounting.byModel.find(x => x.model === 'model-A').total_tokens, 110);
  assert.equal(s.session.accounting.byModel.find(x => x.model === 'model-B').total_tokens, 210);
  assert.equal(s.session.accounting.byModel.reduce((n, row) => n + row.total_tokens, 0), 1220);
  assert.equal(s.today.usage.total_tokens, 320); // Historical carry-over is never today's new usage.
  assert.equal(s.session.accounting.activity.days.reduce((n,row)=>n+row.tokens,0),320);
  assert.equal(s.session.accounting.activity.partial,true);
  const other = store.snapshot({}, { threadId: child, viewKnown: true }); assert.equal(other.session, null);
  store.stop(); const fresh = new SessionStore(directory); t.after(() => fresh.stop()); await fresh.scan(); assert.equal(snapshot(fresh).session.totals.total_tokens, 1220);
});
test('same-chat paginated logs and a small new model counter cannot erase previously observed totals', async t => {
  const { store, directory } = await fixture(t, {
    original: meta(root) + event('event_msg', { type: 'token_count', info: { total_token_usage: usage(1000), last_token_usage: usage(100) } }),
    resumed: meta(root) + event('turn_context', { model: 'model-B' }) + response(root, 'new', 10, { model: 'model-B' }),
    independent: meta(child) + response(child, 'separate', 20, { model: 'model-C' }),
  }); assert.equal(snapshot(store).session.totals.total_tokens, 1010);
  assert.equal(store.snapshot({}, { threadId: child }).session.totals.total_tokens, 30);
  await fs.writeFile(path.join(directory, 'sessions/original.jsonl'), meta(root)); await store.scan();
  assert.equal(snapshot(store).session.totals.total_tokens, 1010);
  assert.equal(snapshot(store).session.accounting.unassignedTokens, 990);
});
test('model counter inconsistencies never fabricate component totals to match a historical checkpoint', async t => {
  const { store } = await fixture(t, { one: meta(root) + event('event_msg', { type: 'token_count', info: { total_token_usage: usage(1000), last_token_usage: usage(1000) } }) + response(root, 'a', 10) + response(root, 'b', 20) });
  const s = snapshot(store); assert.equal(s.session.totals.total_tokens, 1010);
  const unassigned = s.session.accounting.byModel.find(x => x.model.includes('历史未归属'));
  assert.equal(unassigned.total_tokens, 960); assert.equal(unassigned.input_tokens, null); assert.equal(unassigned.output_tokens, null);
});
test('global activity counts dated requests once and separates dated legacy usage from missing history', async t => {
  const recorded = response(root, 'recorded', 100, { model: 'main', thread_token_usage: usage(1000) });
  const { store } = await fixture(t, {
    original: meta(root) + recorded + response(child, 'child-response', 200, { session_id: root, model: 'copy' }),
    overlap: meta(root) + recorded,
    child: meta(child, root) + response(child, 'child-response', 200, { model: 'worker' }),
    legacy: meta('00000000-0000-0000-0000-000000000003') + event('event_msg', { type: 'token_count', info: { total_token_usage: usage(40), last_token_usage: usage(40) } }),
  });
  const state = snapshot(store);
  const today = state.allActivity.days.find(row => row.date === localDay(stamp));
  assert.equal(today.tokens, 370);
  assert.equal(state.today.usage.total_tokens, today.tokens);
  assert.deepEqual(Object.fromEntries(today.byModel.map(row => [row.model, row.tokens])), { main: 110, worker: 210, '模型未记录': 50 });
  assert.equal(state.session.accounting.activity.days[0].tokens, 110);
  assert.equal(state.allActivity.partial, true);
});
test('request details page by date and model, and do not borrow timing or token fields from a turn', async t => {
  const earlier = new Date(stamp);
  earlier.setDate(earlier.getDate() - 1);
  const tokens = { input_tokens: 30, output_tokens: 4 };
  const first = JSON.stringify({ type: 'token_usage_record', timestamp: earlier.toISOString(), payload: { thread_id: root, response_id: 'earlier', turn_id: 'earlier-turn', model: 'A', usage: tokens, duration_ms: 750 } }) + '\n';
  const later = Array.from({ length: 21 }, (_, index) => response(root, `r-${index}`, 100, { model: 'B' })).join('');
  const undated = JSON.stringify({ type: 'token_usage_record', timestamp: null, payload: { thread_id: root, response_id: 'undated', usage: tokens } }) + '\n';
  const { store } = await fixture(t, { one: meta(root) + first + later + later + undated + event('event_msg', { type: 'task_complete', turn_id: 'turn', duration_ms: 1000, time_to_first_token_ms: 400 }) });
  const state = snapshot(store);
  assert.equal(state.session.accounting.activity.partial, true);
  const request = store.modelRequests(root, { model: 'A', start: localDay(earlier), end: localDay(earlier) });
  assert.equal(request.total, 23);
  assert.equal(request.matches, 1);
  assert.equal(request.records[0].turnId, 'earlier-turn');
  assert.equal(request.records[0].durationMs, 750);
  assert.equal(request.records[0].firstTokenMs, null);
  assert.equal(request.records[0].usage.cached_input_tokens, null);
  assert.equal(request.records[0].usage.reasoning_output_tokens, null);
  const secondPage = store.modelRequests(root, { model: 'B', end: localDay(stamp), page: 1 });
  assert.equal(secondPage.matches, 21);
  assert.equal(secondPage.records.length, 1);
  assert.equal(secondPage.records[0].durationMs, null);
  assert.equal(secondPage.records[0].firstTokenMs, null);
  assert.equal(store.modelRequests(root, { start: localDay(earlier) }).matches, 22);
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
