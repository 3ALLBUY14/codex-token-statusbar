'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { SessionStore } = require('../src/session-store.cjs');
async function benchmark() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cache-benchmark-'));
  const home = path.join(directory, 'home'), cacheDirectory = path.join(directory, 'cache');
  const event = (type, payload) => JSON.stringify({ type, timestamp: '2026-10-15T01:00:00Z', payload }) + '\n';
  const rows = [], stores = []; let bytes = 0;
  try {
    await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
    for (let i = 0; i < 100; i++) {
      const id = '00000000-0000-0000-0000-' + String(i).padStart(12, '0');
      const usage = { input_tokens: i + 100, output_tokens: 10, total_tokens: i + 110 };
      const data = event('session_meta', { id, source: 'desktop' }) + event('response_item', { content: 'synthetic-only-'.repeat(37000) }) + event('event_msg', { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } });
      bytes += Buffer.byteLength(data); await fs.writeFile(path.join(home, 'sessions', `${i}.jsonl`), data);
    }
    let expected;
    for (const mode of ['cold', 'warm']) {
      const store = new SessionStore(home, { cacheDirectory }); stores.push(store);
      const start = performance.now(); await store.scan(); const elapsedMs = Math.round(performance.now() - start);
      assert.equal(store.indexing, false); const snapshot = store.snapshot();
      if (expected) { assert.deepEqual(snapshot.session, expected.session); assert.deepEqual(snapshot.today, expected.today); assert.deepEqual(snapshot.sessions, expected.sessions); }
      expected = snapshot; rows.push({ mode, elapsedMs, cacheHits: store.cacheHits });
      await store.flushCache(); store.stop();
    }
    const report = { files: 100, logBytes: bytes, cacheBytes: (await fs.stat(path.join(cacheDirectory, 'statistics-cache.json'))).size, rows, equivalent: true, note: 'Synthetic data only. One cold parse and one cache restore on the same machine; OS file cache is warm. These are statistics loading times, not total app startup.' };
    await fs.mkdir(path.join(__dirname, '..', 'artifacts'), { recursive: true });
    await fs.writeFile(path.join(__dirname, '..', 'artifacts', 'store-benchmark.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    for (const store of stores) store.stop();
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'codex-cache-benchmark-')) throw new Error('Invalid benchmark temporary directory');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
benchmark().catch(error => { console.error(error.message); process.exitCode = 1; });
