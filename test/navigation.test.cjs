'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DesktopNavigation, parseNavigation } = require('../src/desktop-navigation.cjs');
const { CodexIpc } = require('../src/codex-ipc.cjs');
const { SessionStore } = require('../src/session-store.cjs');
const first = '00000000-0000-0000-0000-000000000001';
const second = '00000000-0000-0000-0000-000000000002';
const line = (route, second = 0) => `2026-10-02T09:06:${String(second).padStart(2, '0')}.000Z info [electron-message-handler] IAB_LIFECYCLE received browser sidebar owner sync conversationId=${first} ownerRoutePath=${route} originWebContentsId=1 windowId=1\n`;

test('visible route is parsed independently of browser conversation and background activity', () => {
  assert.equal(parseNavigation(line(`/local/${second}`)).threadId, second);
  assert.equal(parseNavigation(line('/')).threadId, null);
  assert.equal(parseNavigation(line('/local/not-a-thread')).threadId, null);
  assert.equal(parseNavigation(line(`/local/${first}`).replace('received browser sidebar owner sync', 'thread_stream_view_activity_changed')), null);
});

test('one client can retain several subscriptions; removing one does not erase another', () => {
  const ipc = new CodexIpc();
  const follow = (id, following) => ipc.processFrame({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: 'desktop', params: { hostId: 'local', conversationId: id, following } });
  follow(first, true); follow(second, true);
  assert.equal(ipc.routes.size, 2);
  assert.equal(ipc.selectedId, null);
  assert.equal(ipc.status().ambiguous, true);
  follow(second, false);
  assert.equal(ipc.selectedId, first);
});

test('cached idle chat switches follow owner routes without new subscriptions or token writes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-navigation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = new Date();
  const directory = path.join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'codex-desktop-fixture-123-t0-i1-090000-0.log');
  await fs.writeFile(filename, line(`/local/${first}`));
  await fs.writeFile(path.join(directory, 'codex-desktop-other-456-t0-i1-090000-0.log'), line(`/local/${second}`, 59));
  const navigation = new DesktopNavigation({ roots: [root] });
  t.after(() => navigation.stop());
  navigation.setHost(123, 1);
  const settle = async () => { while (navigation.busy) await new Promise(resolve => setTimeout(resolve, 5)); await navigation.scan(); };
  await settle();
  assert.equal(navigation.status().threadId, first);
  await fs.appendFile(filename, line(`/local/${second}`, 1));
  await settle();
  assert.equal(navigation.status().threadId, second);
  const back = line(`/local/${first}`, 2);
  await fs.appendFile(filename, back.slice(0, -1));
  await settle();
  assert.equal(navigation.status().threadId, second, 'partial records must wait for a newline');
  await fs.appendFile(filename, '\n');
  await settle();
  assert.equal(navigation.status().threadId, first);
  navigation.setHost(123, 2);
  assert.equal(navigation.status().ambiguous, true);
  assert.equal(navigation.status().threadId, null);
  navigation.setHost(123, 1);
  await settle();
  await fs.appendFile(filename, line('/', 3));
  await settle();
  const selection = new SessionStore(root).snapshot({}, { ...navigation.status(), viewKnown: navigation.status().known });
  assert.equal(selection.selection.mode, 'empty');
  assert.equal(selection.session, null);
  navigation.setHost(789, 1);
  assert.equal(navigation.status().known, false, 'a different process cannot inherit an old view');
});
