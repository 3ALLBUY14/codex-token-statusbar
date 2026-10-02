'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { FrameDecoder, frame, CodexIpc } = require('../src/codex-ipc.cjs');
const { SessionStore, FileTail } = require('../src/session-store.cjs');
const id1 = '00000000-0000-0000-0000-000000000001';
const id2 = '00000000-0000-0000-0000-000000000002';
const broadcast = (id, following = true, client = 'window-1') => ({ type: 'broadcast', sourceClientId: client, method: 'thread-stream-following-changed', params: { conversationId: id, hostId: 'local', following } });

test('length-framed IPC accepts fragmented prefixes and joined frames', () => {
  const seen = [];
  const decoder = new FrameDecoder(value => seen.push(value));
  const bytes = Buffer.concat([frame(broadcast(id1)), frame(broadcast(id2))]);
  for (let index = 0; index < bytes.length; index += 3) decoder.push(bytes.subarray(index, index + 3));
  assert.equal(seen.length, 2);
  assert.equal(seen[1].params.conversationId, id2);
});

test('bad IPC frames are rejected, malformed JSON does not swallow the next frame', () => {
  assert.throws(() => new FrameDecoder(() => {}).push(Buffer.alloc(4)), /invalid-ipc-frame/);
  const seen = [];
  const decoder = new FrameDecoder(value => seen.push(value));
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(1);
  decoder.push(Buffer.concat([prefix, Buffer.from('{'), frame(broadcast(id1))]));
  assert.equal(seen.length, 1);
});

test('multiple windows are marked ambiguous; disconnect and invalid routes do not keep stale identities', () => {
  const ipc = new CodexIpc();
  ipc.processFrame(broadcast(id1));
  assert.equal(ipc.selectedId, id1);
  ipc.processFrame(broadcast(id1, true, 'same-chat-window'));
  assert.equal(ipc.status().ambiguous, false);
  ipc.processFrame(broadcast(id1, false, 'same-chat-window'));
  ipc.processFrame(broadcast('../../auth.json', true, 'invalid'));
  assert.equal(ipc.routes.size, 1);
  ipc.processFrame(broadcast(id2, true, 'window-2'));
  assert.equal(ipc.selectedId, null);
  assert.equal(ipc.status().ambiguous, true);
  ipc.processFrame({ type: 'broadcast', method: 'client-status-changed', params: { clientId: 'window-2', status: 'disconnected' } });
  assert.equal(ipc.selectedId, id1);
  ipc.processFrame(broadcast(id1, false));
  assert.equal(ipc.selectedId, null);
});

test('an initialized but unbound connection resynchronizes without a chat switch or token event', { timeout: 8000 }, async t => {
  const sockets = new Set();
  let registrations = 0;
  let discoveryReply;
  let currentSocket;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const decoder = new FrameDecoder(value => {
      if (value.method === 'initialize') {
        registrations++;
        currentSocket = socket;
        socket.write(frame({ type: 'response', requestId: value.requestId, method: 'initialize', resultType: 'success', result: { clientId: 'statusbar-client' } }));
        // Simulate a missed initial snapshot; the next registration restores it.
        if (registrations > 1) socket.write(frame({ ...broadcast(id1), targetClientIds: ['statusbar-client'] }));
        socket.write(frame({ type: 'client-discovery-request', requestId: 'discovery-1', request: { method: 'unhandled' } }));
      } else if (value.type === 'client-discovery-response') discoveryReply = value;
    });
    socket.on('data', data => decoder.push(data));
  });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ipc = new CodexIpc({ port: server.address().port, host: '127.0.0.1' }, { recoveryDelay: 30, recoveryCooldown: 100 });
  t.after(() => ipc.stop());
  const waitFor = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'IPC state did not recover');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  ipc.start();
  await waitFor(() => ipc.selectedId === id1 && discoveryReply);
  assert.equal(registrations, 2);
  assert.equal(ipc.connected, true);
  assert.deepEqual(discoveryReply.response, { canHandle: false });
  // An idle chat switch needs only the route events, not a log write.
  currentSocket.write(Buffer.concat([frame(broadcast(id2)), frame(broadcast(id1, false))]));
  await waitFor(() => ipc.selectedId === id2);
  currentSocket.write(frame({ ...broadcast(id1), targetClientIds: ['another-client'] }));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(ipc.selectedId, id2);
  assert.equal(registrations, 2, 'a bound connection must stay open');
  // Losing the route later also recovers automatically.
  currentSocket.write(frame(broadcast(id2, false)));
  await waitFor(() => registrations === 3 && ipc.selectedId === id1);
  ipc.stop();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(registrations, 3, 'stopping cancels recovery');
});

function records(id, tokens = 100) {
  return [
    { type: 'session_meta', payload: { id, source: 'vscode' } },
    { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: tokens, output_tokens: 10, cached_input_tokens: 50, reasoning_output_tokens: 2 }, last_token_usage: { input_tokens: tokens, output_tokens: 10, total_tokens: tokens + 10 }, model_context_window: 1000 } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
}

test('switching to an idle chat selects its data; a new/missing chat clears old metrics', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-statusbar-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessions = path.join(directory, 'sessions');
  await fs.mkdir(sessions);
  await fs.writeFile(path.join(sessions, 'first.jsonl'), records(id1));
  await fs.writeFile(path.join(sessions, 'second.jsonl'), records(id2, 200));
  const store = new SessionStore(directory);
  t.after(() => store.stop());
  await store.scan();
  assert.equal(store.snapshot({}, { threadId: id1 }).session.totals.total_tokens, 110);
  assert.equal(store.snapshot({}, { threadId: id2 }).session.totals.total_tokens, 210);
  assert.equal(store.snapshot({}, { threadId: '00000000-0000-0000-0000-000000000003' }).session, null);
  assert.equal(store.snapshot({}, { ambiguous: true }).session, null);
  assert.equal(store.snapshot({ pinnedThreadId: id1 }, { threadId: id2 }).session.threadId, id1);
});

test('incremental reads wait for a completed line and restart after file truncation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-statusbar-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'log.jsonl');
  const first = records(id1);
  await fs.writeFile(filename, first.slice(0, -1));
  const tail = new FileTail(filename);
  await tail.refresh();
  assert.equal(tail.accumulator.hasUsage, false);
  await fs.appendFile(filename, '\n');
  await tail.refresh();
  assert.equal(tail.accumulator.totals.total_tokens, 110);
  await fs.writeFile(filename, JSON.stringify({ type: 'session_meta', payload: { id: id2, source: 'vscode' } }) + '\n');
  await tail.refresh();
  assert.equal(tail.accumulator.id, id2);
  assert.equal(tail.accumulator.hasUsage, false);
});

test('session copies and archived duplicates are counted once in daily totals', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-statusbar-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'sessions'));
  await fs.mkdir(path.join(directory, 'archived_sessions'));
  await fs.writeFile(path.join(directory, 'sessions', 'a.jsonl'), records(id1));
  await fs.writeFile(path.join(directory, 'archived_sessions', 'copy.jsonl'), records(id1));
  const store = new SessionStore(directory);
  t.after(() => store.stop());
  await store.scan();
  assert.equal(store.snapshot().health.sessionCount, 1);
  assert.equal(store.snapshot().today.usage.total_tokens, 110);
});
