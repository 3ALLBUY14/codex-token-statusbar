'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveSpeed, countTokens } = require('../src/live-speed.cjs');
const { CodexIpc } = require('../src/codex-ipc.cjs');
const id = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002';
const text = (at, insert, threadId = id, field = 'text') => ({ type: 'text', key: { threadId, entityKey: 'current-turn', itemId: 'message' }, target: { field }, edits: [{ at, deleteCount: 0, insert }] });
const patch = (revision, changes) => ({ type: 'patches', baseRevision: revision - 1, revision, acceptedTextChanges: changes });
test('live rate uses current streamed text, becomes stale, and never counts snapshots or reasoning', () => {
  let now = 0; const live = new LiveSpeed({ now: () => now, count: s => s.length }); live.select(id);
  live.ingest({ type: 'snapshot', revision: 1, conversationState: { text: 'old history' } });
  live.ingest(patch(2, [text(0, 'abcd')])); assert.equal(live.snapshot().tokensPerSecond, null);
  now = 1000; live.ingest(patch(3, [text(4, 'efgh'), text(0, 'ignored', id, 'summary'), text(0, 'ignored', other)]));
  assert.equal(live.snapshot().tokensPerSecond, 8); assert.equal(live.snapshot().kind, 'visible-output-estimate');
  live.ingest(patch(3, [text(4, 'efgh')])); assert.equal(live.snapshot().tokensPerSecond, 8);
  now = 3100; assert.equal(live.snapshot().status, 'waiting');
  live.select(other); assert.equal(live.snapshot().tokensPerSecond, null); assert.equal(live.items.size, 0);
});
test('revision gaps, replacements, late text and tokenizer failures cannot produce fake rates', () => {
  let now = 0; const live = new LiveSpeed({ now: () => now, count: s => s.length }); live.select(id);
  live.ingest(patch(1, [text(100, 'history')])); now = 1000; assert.equal(live.snapshot().tokensPerSecond, null);
  live.ingest(patch(3, [text(107, 'gap')])); assert.equal(live.snapshot().tokensPerSecond, null);
  const edit = text(0, 'replacement'); edit.edits[0].deleteCount = 5; live.ingest(patch(4, [edit])); assert.equal(live.snapshot().tokensPerSecond, null);
  const failed = new LiveSpeed({ now: () => now, count: () => { throw Error('no encoder'); } }); failed.select(id); failed.ingest(patch(1, [text(0, 'x')])); assert.equal(failed.snapshot().status, 'unavailable');
});
test('tokenizer handles multilingual text locally, and public snapshots contain no text', () => {
  assert.equal(countTokens('hello world'), 2); assert.ok(countTokens('你好世界') > 0);
  const live = new LiveSpeed(); live.select(id); live.ingest(patch(1, [text(0, 'private response')]));
  assert.equal(JSON.stringify(live.snapshot()).includes('private'), false);
  for (let i = 2; i < 1000; i++) live.ingest(patch(i, [text(0, 'x'.repeat(50))]));
  assert.ok(live.items.size <= 32); for (const value of live.items.values()) assert.ok(value.suffix.length <= 512);
  for (let i = 1000; i < 1100; i++) { const change = text(100, 'late history'); change.key.itemId = 'message-' + i; live.ingest(patch(i, [change])); }
  assert.equal(live.items.size, 32);
});
test('stream subscription follows only selected chat, rejects unknown versions, and unsubscribes', () => {
  const c = new CodexIpc(), sent = [], received = []; c.connected = true; c.clientId = 'self'; c.send = v => sent.push(v); c.on('stream', v => received.push(v));
  c.processFrame({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: 'owner', params: { conversationId: id, hostId: 'local', following: true } });
  c.setStreamThread(id); assert.equal(sent.at(-1).params.following, true);
  const frame = { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, params: { conversationId: id, hostId: 'local', change: patch(1, []) } };
  c.processFrame({ ...frame, version: 12 }); c.processFrame({ ...frame, params: { ...frame.params, conversationId: other } }); assert.equal(received.length, 0);
  c.processFrame(frame); assert.equal(received.length, 1);
  c.setStreamThread(other); assert.equal(sent.at(-1).params.following, false); assert.equal(c.routes.size, 1);
  c.setStreamThread(id); c.stop(); assert.equal(sent.at(-1).params.following, false);
});
