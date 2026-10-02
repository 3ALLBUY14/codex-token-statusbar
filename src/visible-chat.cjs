'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { UUID } = require('./codex-ipc.cjs');
const MAX_INDEX_BYTES = 16 * 1024 * 1024;

// Companion to the route reader: titles are a fallback, never a guessed ID.
class VisibleChat extends EventEmitter {
  constructor(home) {
    super();
    this.filename = path.join(home, 'session_index.jsonl');
    this.names = new Map();
    this.byId = new Map();
    this.stamp = null;
    this.indexed = false;
    this.title = null;
    this.processId = 0;
    this.handle = 0;
    this.changedAt = 0;
    this.busy = false;
    this.stopped = false;
  }
  observe(title, processId, handle) {
    const value = typeof title === 'string' && title.trim() && title.length <= 2048 ? title : null;
    if (value === this.title && processId === this.processId && handle === this.handle) return;
    this.title = value;
    this.processId = processId;
    this.handle = handle;
    this.changedAt = Date.now();
    this.emit('status');
  }
  status(processId) {
    const observed = Boolean(this.title && this.processId === processId);
    return { observed, indexed: this.indexed, title: observed ? this.title : null, ids: observed ? this.names.get(this.title) ?? [] : [], changedAt: this.changedAt };
  }
  titleForId(id) { return this.byId.get(id) ?? null; }
  async scan() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const stat = await fs.stat(this.filename);
      if (stat.size > MAX_INDEX_BYTES) throw new Error('index-size-limit');
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (this.stamp === stamp) return;
      const contents = await fs.readFile(this.filename, 'utf8');
      if (Buffer.byteLength(contents) > MAX_INDEX_BYTES) throw new Error('index-size-limit');
      const byId = new Map();
      // A concurrent append is not visible until its newline is committed.
      for (const line of contents.slice(0, contents.lastIndexOf('\n') + 1).split('\n')) {
        try {
          const item = JSON.parse(line);
          if (UUID.test(item.id ?? '') && typeof item.thread_name === 'string' && item.thread_name.length <= 2048) byId.set(item.id, item.thread_name);
        } catch { /* Skip malformed metadata records. */ }
      }
      const names = new Map();
      for (const [id, name] of byId) { if (!names.has(name)) names.set(name, []); names.get(name).push(id); }
      this.byId = byId; this.names = names; this.stamp = stamp; this.indexed = true;
      if (!this.stopped) this.emit('status');
    } catch {
      const changed = this.indexed;
      this.byId.clear(); this.names.clear(); this.stamp = null; this.indexed = false;
      if (changed && !this.stopped) this.emit('status');
    } finally { this.busy = false; }
  }
  start() { void this.scan(); this.timer = setInterval(() => { void this.scan(); }, 1000); }
  stop() { this.stopped = true; clearInterval(this.timer); }
}

function resolveVisibleSelection(navigation, title, hasRouteTitle = false) {
  if (navigation.known && !navigation.ambiguous) {
    const consistent = !title.observed || !title.indexed ||
      title.ids.includes(navigation.threadId) ||
      (navigation.threadId && !hasRouteTitle && title.ids.length === 0);
    if (consistent || navigation.time >= title.changedAt) {
      return { ...navigation, viewKnown: true };
    }
  }
  if (title.observed && title.indexed) {
    return { threadId: title.ids.length === 1 ? title.ids[0] : null, ambiguous: title.ids.length > 1, viewKnown: true, source: 'visible-document-title' };
  }
  if (navigation.known || navigation.ambiguous) return { ...navigation, viewKnown: navigation.known };
  return { threadId: null, ambiguous: false, viewKnown: false, source: null };
}
module.exports = { VisibleChat, resolveVisibleSelection };
