'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { UUID } = require('./codex-ipc.cjs');
const BOOTSTRAP_BYTES = 4 * 1024 * 1024;
const PASS_BYTES = 1024 * 1024;

// Owner sync reports the visible route, including returns to retained views.
// Stream subscriptions also include background chats and are not navigation.
function parseNavigation(line) {
  if (!line.includes('IAB_LIFECYCLE received browser sidebar owner sync')) return null;
  const route = /(?:^|\s)ownerRoutePath=(\S+)/.exec(line)?.[1];
  const windowId = /(?:^|\s)windowId=(\d+)(?:\s|$)/.exec(line)?.[1];
  const time = Date.parse(line.slice(0, 24));
  if (!route || !windowId || !Number.isFinite(time)) return null;
  const id = /^\/local\/([^/?#]+)(?:[/?#]|$)/.exec(route)?.[1];
  return { threadId: UUID.test(id ?? '') ? id : null, windowId, time };
}

async function logRoots() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const roots = [path.join(local, 'Codex', 'Logs'), path.join(local, 'OpenAI', 'Codex', 'Logs')];
  const packages = path.join(local, 'Packages');
  try {
    for (const item of await fs.readdir(packages, { withFileTypes: true })) {
      if (item.isDirectory() && /^OpenAI\.Codex_/i.test(item.name)) roots.push(path.join(packages, item.name, 'LocalCache', 'Local', 'Codex', 'Logs'));
    }
  } catch { /* Standalone installations need no MSIX package directory. */ }
  return roots;
}

class DesktopNavigation extends EventEmitter {
  constructor({ roots = null, pollMs = 250 } = {}) {
    super();
    this.roots = roots;
    this.pollMs = pollMs;
    this.processId = 0;
    this.windowCount = 0;
    this.record = null;
    this.tails = new Map();
    this.discoveredAt = 0;
    this.stopped = false;
    this.busy = false;
  }
  status() {
    const ambiguous = this.windowCount > 1;
    return { known: Boolean(this.record), threadId: ambiguous ? null : this.record?.threadId ?? null, time: this.record?.time ?? 0, ambiguous, source: this.record ? 'desktop-navigation' : null };
  }
  setHost(processId, windowCount) {
    if (!Number.isSafeInteger(processId) || processId < 0 || !Number.isSafeInteger(windowCount) || windowCount < 0) return;
    const before = JSON.stringify(this.status());
    if (processId !== this.processId) {
      this.processId = processId;
      this.record = null;
      this.tails.clear();
      this.discoveredAt = 0;
    }
    this.windowCount = windowCount;
    if (before !== JSON.stringify(this.status())) this.emit('status', this.status());
    void this.scan();
  }
  async discover() {
    const processId = this.processId;
    this.roots ??= await logRoots();
    const files = [];
    for (const root of this.roots) {
      for (let day = 0; day < 3; day++) {
        const date = new Date(); date.setDate(date.getDate() - day);
        const directory = path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
        try {
          for (const item of await fs.readdir(directory, { withFileTypes: true })) {
            if (item.isFile() && item.name.includes(`-${processId}-t0-`) && item.name.endsWith('.log')) files.push(path.join(directory, item.name));
          }
        } catch { /* A missing day or temporarily unreadable log is retried. */ }
      }
    }
    if (this.processId !== processId || this.stopped) return;
    for (const filename of files) if (!this.tails.has(filename)) this.tails.set(filename, { offset: null, pending: '', identity: null });
    for (const filename of this.tails.keys()) if (!files.includes(filename)) this.tails.delete(filename);
    this.discoveredAt = Date.now();
  }
  async scan() {
    if (this.busy || this.stopped || !this.processId) return;
    this.busy = true;
    const processId = this.processId;
    const before = JSON.stringify(this.status());
    try {
      if (Date.now() - this.discoveredAt >= 2000) await this.discover();
      if (this.processId !== processId || this.stopped) return;
      for (const [filename, tail] of this.tails) {
        let file;
        try {
          file = await fs.open(filename, 'r');
          const stat = await file.stat();
          const identity = `${stat.dev}:${stat.ino}`;
          if (tail.offset === null || stat.size < tail.offset || tail.identity !== identity) {
            tail.offset = Math.max(0, stat.size - BOOTSTRAP_BYTES);
            tail.pending = ''; tail.identity = identity;
            tail.skipPartial = tail.offset > 0;
          }
          const length = Math.min(stat.size - tail.offset, tail.offset === 0 || tail.skipPartial ? BOOTSTRAP_BYTES : PASS_BYTES);
          if (!length) continue;
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await file.read(buffer, 0, length, tail.offset);
          tail.offset += bytesRead;
          const lines = (tail.pending + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
          tail.pending = lines.pop();
          if (tail.pending.length > 65536) { tail.pending = ''; tail.skipPartial = true; }
          if (tail.skipPartial) { lines.shift(); tail.skipPartial = false; }
          for (const line of lines) {
            const record = parseNavigation(line);
            if (record && (!this.record || record.time >= this.record.time) && this.processId === processId) this.record = record;
          }
        } catch { /* Do not replace the selected chat with the last token writer. */ }
        finally { await file?.close(); }
      }
    } finally {
      this.busy = false;
      if (!this.stopped && before !== JSON.stringify(this.status())) this.emit('status', this.status());
    }
  }
  start() { this.timer = setInterval(() => { void this.scan(); }, this.pollMs); }
  stop() { this.stopped = true; clearInterval(this.timer); }
}
module.exports = { DesktopNavigation, parseNavigation };
