'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { UUID } = require('./codex-ipc.cjs');
const LIMIT = 32 * 1024 * 1024;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0;
const usage = value => value && ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'].every(key => count(value[key]));
function validCheckpoint(value) {
  const s = value?.snapshot;
  return value && count(value.size) && Number.isFinite(value.mtimeMs) && typeof value.identity === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint ?? '') && typeof value.isRootDesktop === 'boolean' && count(value.skippedLines) && s && UUID.test(s.threadId ?? '') && s.active === false && usage(s.totals) && s.context && s.toolUsage && count(s.toolUsage.total) && Array.isArray(s.toolUsage.records) && s.toolUsage.records.length <= 200 && Array.isArray(s.toolUsage.byType) && Array.isArray(value.daily) && value.daily.every(row => Array.isArray(row) && /^\d{4}-\d\d-\d\d$/.test(row[0]) && usage(row[1]));
}
async function fingerprint(handle, size) {
  const hash = crypto.createHash('sha256');
  for (const offset of [0, Math.max(0, size - 4096)]) {
    const buffer = Buffer.alloc(Math.min(4096, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    hash.update(buffer.subarray(0, bytesRead));
  }
  return hash.digest('hex');
}
class StatisticsCache {
  constructor(directory, home, version) {
    this.filename = path.join(directory, 'statistics-cache.json');
    this.home = path.resolve(home); this.source = digest(this.home); this.version = version;
    this.entries = new Map(); this.error = null;
  }
  key(filename) {
    const relative = path.relative(this.home, path.resolve(filename));
    if (path.isAbsolute(relative) || relative.startsWith('..' + path.sep) || !/^(sessions|archived_sessions)[\\/].+\.jsonl$/.test(relative)) return null;
    return relative;
  }
  async load() {
    try {
      if ((await fs.stat(this.filename)).size > LIMIT) throw new Error('cache-size');
      const wrapper = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      if (typeof wrapper.payload !== 'string' || wrapper.payload.length > LIMIT || digest(wrapper.payload) !== wrapper.sha256) throw new Error('cache-checksum');
      const data = JSON.parse(wrapper.payload);
      if (data.version !== this.version || data.source !== this.source) return;
      if (!Array.isArray(data.entries) || data.entries.length > 16384) throw new Error('cache-shape');
      for (const [key, value] of data.entries) if (this.key(path.join(this.home, key)) === key && validCheckpoint(value)) this.entries.set(key, value);
    } catch (error) { this.entries.clear(); if (error.code !== 'ENOENT') this.error = 'read-error'; }
  }
  take(filename) { const key = this.key(filename), value = this.entries.get(key); this.entries.delete(key); return value; }
  async save(files) {
    try {
      const entries = []; let bytes = 0;
      for (const [filename, tail] of [...files].sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)) {
        const key = this.key(filename), value = tail.checkpoint();
        if (!key || !value) continue;
        const text = JSON.stringify([key, value]); bytes += Buffer.byteLength(text);
        if (bytes > LIMIT / 2 - 4096) break;
        entries.push([key, value]);
        if (entries.length % 32 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      const payload = JSON.stringify({ version: this.version, source: this.source, entries });
      await fs.mkdir(path.dirname(this.filename), { recursive: true });
      await fs.writeFile(this.filename + '.tmp', JSON.stringify({ payload, sha256: digest(payload) }), { mode: 0o600 });
      await fs.rename(this.filename + '.tmp', this.filename); this.error = null;
    } catch { this.error = 'write-error'; }
  }
}
module.exports = { StatisticsCache, fingerprint, validCheckpoint };
