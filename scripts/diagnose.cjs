'use strict';
const { SessionStore } = require('../src/session-store.cjs');
const { CodexIpc } = require('../src/codex-ipc.cjs');

(async () => {
  const store = new SessionStore();
  const ipc = new CodexIpc();
  ipc.start();
  await store.scan();
  await new Promise(resolve => setTimeout(resolve, 1500));
  const state = store.snapshot({}, ipc.status());
  // Diagnostics report numeric metrics only, never paths, IDs, or transcript text.
  console.log(JSON.stringify({
    health: state.health,
    ipc: { connected: ipc.connected, selected: Boolean(ipc.selectedId), routes: ipc.routes.size },
    selectionMode: state.selection.mode,
    hasUsage: state.session?.hasUsage ?? false,
    tokens: state.session?.totals ?? null,
    context: state.session?.context ?? null,
    lastTurn: state.session?.lastTurn ?? null,
    today: state.today,
  }, null, 2));
  ipc.stop();
  store.stop();
})().catch(error => { console.error(error.code ?? error.message); process.exitCode = 1; });
