'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionAccumulator, JsonlDecoder, averageSpeed, contextStatus } = require('../src/metrics.cjs');
const id = '00000000-0000-0000-0000-000000000001';
const timestamp = '2026-10-02T03:00:00.000Z';
const event = payload => ({ type: 'event_msg', timestamp, payload });
const total = (input, output, cached = 0, reasoning = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: reasoning, total_tokens: input + output });
const count = (cumulative, latest, capacity = 1000) => event({ type: 'token_count', info: { total_token_usage: cumulative, last_token_usage: latest, model_context_window: capacity } });
function accumulator() { const result = new SessionAccumulator(); result.processEvent({ type: 'session_meta', payload: { id, source: 'vscode' } }); return result; }

test('cache and reasoning subsets are never counted twice; identical snapshots do not add usage', () => {
  const result = accumulator();
  const record = count(total(1000, 200, 800, 100), total(1000, 200, 800, 100));
  result.processEvent(record);
  result.processEvent(record);
  assert.equal(result.snapshot().totals.total_tokens, 1200);
  assert.equal([...result.daily.values()][0].total_tokens, 1200);
  assert.equal(result.snapshot().cacheHitPercent, 80);
});

test('context can fall after compaction without lowering session cumulative tokens', () => {
  const result = accumulator();
  result.processEvent(count(total(1000, 200), total(800, 100)));
  result.processEvent(count(total(1100, 220), total(100, 20)));
  assert.equal(result.snapshot().context.used, 120);
  assert.equal(result.snapshot().context.percent, 12);
  assert.equal(result.snapshot().totals.total_tokens, 1320);
});

test('context warnings use a lower threshold for million-token windows, and explicit overflow survives until the next turn', () => {
  assert.equal(contextStatus(39.9, 1000000).level, 'normal');
  assert.equal(contextStatus(40, 1000000).level, 'warning');
  assert.equal(contextStatus(60, 1000000).level, 'critical');
  assert.equal(contextStatus(69.9, 258400).level, 'normal');
  assert.equal(contextStatus(70, 258400).level, 'warning');
  assert.equal(contextStatus(85, 258400).level, 'critical');
  const result = accumulator();
  result.processEvent(event({ type: 'task_started', turn_id: 'overflow' }));
  result.processEvent(event({ type: 'task_complete', turn_id: 'overflow', error: { code: 'context_length_exceeded' } }));
  assert.equal(result.snapshot().context.exceeded, true);
  result.processEvent(event({ type: 'task_started', turn_id: 'next' }));
  assert.equal(result.snapshot().context.exceeded, false);
});

test('completed tool items count once per id, track failures and only sum recorded durations', () => {
  const result = accumulator();
  const command = event({ type: 'item_completed', item: { id: 'tool-1', type: 'CommandExecution', status: 'completed', duration: { secs: 2, nanos: 500000000 } } });
  result.processEvent(command);
  result.processEvent(command);
  result.processEvent(event({ type: 'item_completed', item: { id: 'tool-2', type: 'CommandExecution', status: 'failed', exit_code: 1, duration: { secs: 1, nanos: 0 } } }));
  result.processEvent(event({ type: 'item_completed', item: { id: 'tool-3', type: 'FileChange', status: 'completed' } }));
  result.processEvent(event({ type: 'item_completed', item: { id: 'tool-4', type: 'Unknown', status: 'failed' } }));
  const tools = result.snapshot().toolUsage;
  assert.deepEqual({ total: tools.total, failed: tools.failed, timed: tools.timed, durationMs: tools.durationMs }, { total: 3, failed: 1, timed: 2, durationMs: 3500 });
  assert.equal(tools.byType.find(item => item.type === 'CommandExecution').failed, 1);
  assert.equal(tools.byType.find(item => item.type === 'FileChange').total, 1);
});

test('turn-level tool usage and model requests reset between turns while session totals persist', () => {
  const result = accumulator();
  result.processEvent(event({ type: 'task_started', turn_id: 'one' }));
  result.processEvent(count(total(100, 10), total(100, 10)));
  result.processEvent(event({ type: 'item_completed', item: { id: 'one-tool', type: 'CommandExecution', status: 'failed', duration: { secs: 1, nanos: 0 } } }));
  assert.equal(result.snapshot().turnToolUsage.failed, 1);
  result.processEvent(event({ type: 'task_complete', turn_id: 'one' }));
  assert.equal(result.snapshot().turnToolUsage.total, 1);
  assert.equal(result.snapshot().turnRequests, 1);
  result.processEvent(event({ type: 'task_started', turn_id: 'two' }));
  assert.equal(result.snapshot().turnToolUsage.total, 0);
  result.processEvent(event({ type: 'item_completed', item: { id: 'two-tool', type: 'FileChange', status: 'completed' } }));
  result.processEvent(event({ type: 'turn_aborted' }));
  assert.equal(result.snapshot().turnToolUsage.total, 1);
  assert.equal(result.snapshot().toolUsage.total, 2);
});

test('turn average uses all model calls in that turn, excludes first-token delay, and is labelled as an average', () => {
  const result = accumulator();
  result.processEvent(count(total(1000, 100), total(1000, 100)));
  result.processEvent(event({ type: 'task_started', turn_id: 'turn-1' }));
  result.processEvent(count(total(1200, 150), total(200, 50)));
  result.processEvent(count(total(1300, 250), total(100, 100)));
  result.processEvent(event({ type: 'task_complete', turn_id: 'turn-1', duration_ms: 12000, time_to_first_token_ms: 2000 }));
  const turn = result.snapshot().lastTurn;
  assert.equal(turn.tokens.output_tokens, 150);
  assert.equal(turn.speed.tokensPerSecond, 15);
  assert.equal(turn.speed.kind, 'turn-average');
  assert.equal(turn.speed.includesToolTime, true);
  assert.equal(turn.requests, 2);
});

test('resumed cumulative history is not counted as the first turn or as new daily usage', () => {
  const result = accumulator();
  result.processEvent(event({ type: 'task_started', turn_id: 'resumed' }));
  result.processEvent(count(total(11813683, 93471, 11445760, 30330), total(134797, 293, 134528, 0)));
  result.processEvent(count(total(12961496, 99048, 12581120, 32672), total(145709, 66, 145280, 0)));
  result.processEvent(event({ type: 'task_complete', turn_id: 'resumed', duration_ms: 386270, time_to_first_token_ms: 116849 }));
  const snapshot = result.snapshot();
  assert.equal(snapshot.totals.total_tokens, 13060544);
  assert.equal(snapshot.lastTurn.tokens.output_tokens, 5870);
  assert.equal(snapshot.lastTurn.speed.tokensPerSecond.toFixed(1), '21.8');
  assert.equal(snapshot.lastTurn.speed.baselineInferred, true);
  assert.equal([...result.daily.values()][0].total_tokens, 1288480);
  result.processEvent(event({ type: 'task_started', turn_id: 'next' }));
  result.processEvent(count(total(12962496, 99148, 12581120, 32672), total(1000, 100)));
  result.processEvent(event({ type: 'task_complete', turn_id: 'next', duration_ms: 10000 }));
  assert.equal(result.lastTurn.speed.tokensPerSecond, 10);
  assert.equal(result.lastTurn.speed.baselineInferred, false);
});

test('missing initial request usage suppresses the first speed and marks daily usage incomplete', () => {
  const result = accumulator();
  result.processEvent(event({ type: 'task_started', turn_id: 'unknown-baseline' }));
  result.processEvent(count(total(1000000, 100000), null));
  result.processEvent(count(total(1000100, 100010), total(100, 10)));
  result.processEvent(event({ type: 'task_complete', turn_id: 'unknown-baseline', duration_ms: 1000 }));
  assert.equal(result.snapshot().lastTurn.speed, null);
  assert.equal(result.snapshot().usageIncomplete, true);
  assert.equal([...result.daily.values()][0].total_tokens, 110);
});

test('unknown timing does not create a fake rate; missing TTFT falls back to complete turn duration', () => {
  assert.equal(averageSpeed(10, null, null), null);
  assert.equal(averageSpeed(0, 1000, 0), null);
  assert.equal(averageSpeed(10, 1000, null).tokensPerSecond, 10);
  assert.equal(averageSpeed(10, 1000, 1000).excludesFirstToken, false);
});

test('failed, interrupted, mismatched, and unstarted turns do not reuse previous completed speed', () => {
  const result = accumulator();
  result.processEvent(event({ type: 'task_complete', turn_id: 'unknown', duration_ms: 1000 }));
  assert.equal(result.lastTurn, null);
  result.processEvent(event({ type: 'task_started', turn_id: 'turn-1' }));
  result.processEvent(count(total(100, 10), total(100, 10)));
  result.processEvent(event({ type: 'task_complete', turn_id: 'turn-2', duration_ms: 1000 }));
  assert.equal(result.lastTurn, null);
  result.processEvent(event({ type: 'task_complete', turn_id: 'turn-1', duration_ms: 1000, error: { message: 'failed' } }));
  assert.equal(result.lastTurn.speed, null);
  result.processEvent(event({ type: 'task_started', turn_id: 'turn-3' }));
  result.processEvent(event({ type: 'turn_aborted' }));
  assert.equal(result.lastTurn.status, 'interrupted');
  assert.equal(result.lastTurn.speed, null);
});

test('counter rollback is flagged without double counting replay', () => {
  const result = accumulator();
  result.processEvent(count(total(1000, 100), total(1000, 100)));
  result.processEvent(count(total(100, 10), total(100, 10)));
  assert.equal(result.snapshot().totals.total_tokens, 1100);
  assert.equal([...result.daily.values()][0].total_tokens, 1100);
  assert.equal(result.snapshot().accountingWarning, true);
});

test('forked owner snapshots are skipped until the new thread owns its usage', () => {
  const result = accumulator();
  result.processEvent(event({ type: 'thread_settings_applied', thread_id: '00000000-0000-0000-0000-000000000002' }));
  result.processEvent(count(total(1000, 100), total(1000, 100)));
  assert.equal(result.hasUsage, false);
  result.processEvent(event({ type: 'thread_settings_applied', thread_id: id }));
  result.processEvent(count(total(100, 10), total(100, 10)));
  assert.equal(result.totals.total_tokens, 110);
});

test('split UTF-8 and partial writes are reconstructed exactly, with no premature parsing', () => {
  const seen = [];
  const decoder = new JsonlDecoder(line => seen.push(JSON.parse(line)));
  const bytes = Buffer.from(JSON.stringify({ text: '中文', value: 42 }) + '\n');
  for (const byte of bytes.subarray(0, bytes.length - 1)) decoder.push(Buffer.from([byte]));
  assert.deepEqual(seen, []);
  decoder.push(bytes.subarray(bytes.length - 1));
  assert.deepEqual(seen, [{ text: '中文', value: 42 }]);
});

test('oversized transcript records are bounded and subsequent usage records still parse', () => {
  const seen = [];
  const decoder = new JsonlDecoder(line => seen.push(line), 32);
  decoder.push(Buffer.from('x'.repeat(100)));
  decoder.push(Buffer.from('\n{"ok":true}\n'));
  assert.equal(decoder.skippedLines, 1);
  assert.deepEqual(seen, ['{"ok":true}']);
});

test('malformed and negative usage does not overwrite known metrics', () => {
  const result = accumulator();
  result.processEvent(count(total(100, 10), total(100, 10)));
  result.processLine('{invalid}');
  result.processEvent(count(total(-1, 10), total(1, 10)));
  assert.equal(result.totals.total_tokens, 110);
  assert.equal(result.malformedLines, 1);
});
