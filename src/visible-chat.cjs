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
    this.indexError = null;
    this.confirmed = null;
    this.title = null;
    this.processId = 0;
    this.handle = 0;
    this.changedAt = 0;
    this.busy = false;
    this.stopped = false;
    this.active = true;
    this.lastPolledAt = 0;
  }
  setActive(active) { this.active = Boolean(active); }
  observe(title, processId, handle) {
    const value = typeof title === 'string' && title.trim() && title.length <= 2048 ? title : null;
    if (value === this.title && processId === this.processId && handle === this.handle) return;
    this.title = value;
    this.confirmed = null;
    this.processId = processId;
    this.handle = handle;
    this.changedAt = Date.now();
    this.emit('status');
  }
  status(processId) {
    const observed = Boolean(this.title && this.processId === processId);
    const ids = observed ? this.names.get(this.title) ?? [] : [];
    if (!this.indexError && this.indexed && observed && ids.length === 1) this.confirmed = { title: this.title, processId, handle: this.handle };
    const cachedMatch = Boolean(this.confirmed && observed && this.confirmed.title === this.title && this.confirmed.processId === processId && this.confirmed.handle === this.handle);
    return { observed, indexed: this.indexed, stale: Boolean(this.indexError), error: this.indexError, cachedMatch, title: observed ? this.title : null, ids, changedAt: this.changedAt };
  }
  titleForId(id) { return this.byId.get(id) ?? null; }
  async scan() {
    if (this.busy || this.stopped) return;
    if (!this.active && Date.now() - this.lastPolledAt < 5000) return;
    this.lastPolledAt = Date.now();
    this.busy = true;
    try {
      const stat = await fs.stat(this.filename);
      if (stat.size > MAX_INDEX_BYTES) throw new Error('index-size-limit');
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (this.stamp === stamp) {
        if (this.indexError) { this.indexError = null; this.emit('status'); }
        return;
      }
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
      this.byId = byId; this.names = names; this.stamp = stamp; this.indexed = true; this.indexError = null; this.confirmed = null;
      if (!this.stopped) this.emit('status');
    } catch (error) {
      const code = error.message === 'index-size-limit' ? 'size-limit' : ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'read-error';
      const changed = this.indexError !== code;
      // Keep labels and a previously confirmed observation, but never use stale
      // names to infer a newly opened chat or a renamed/duplicate title.
      this.indexError = code;
      if (changed && !this.stopped) this.emit('status');
    } finally { this.busy = false; }
  }
  start() { void this.scan(); this.timer = setInterval(() => { void this.scan(); }, 1000); }
  stop() { this.stopped = true; clearInterval(this.timer); }
}

function resolveVisibleSelection(navigation, title, hasRouteTitle = false, now = Date.now()) {
  if (title.stale && !title.cachedMatch) {
    if (navigation.known && !navigation.ambiguous && (!title.observed || navigation.time >= title.changedAt)) return { ...navigation, viewKnown: true, confidence: 'route' };
    return { threadId: null, ambiguous: true, viewKnown: true, source: 'visible-document-title', confidence: 'uncertain', reason: 'index-unavailable' };
  }
  if (title.observed && title.indexed && title.ids.length > 1 &&
      (!navigation.known || navigation.ambiguous || !title.ids.includes(navigation.threadId) || navigation.time < title.changedAt || now - navigation.time > 60000)) {
    return { threadId: null, ambiguous: true, viewKnown: true, source: 'visible-document-title', confidence: 'uncertain', reason: 'duplicate-title' };
  }
  if (navigation.known && !navigation.ambiguous) {
    const consistent = !title.observed || !title.indexed ||
      title.ids.includes(navigation.threadId) ||
      (navigation.threadId && !hasRouteTitle && title.ids.length === 0);
    if (consistent || navigation.time >= title.changedAt) {
      return { ...navigation, viewKnown: true, confidence: 'route' };
    }
  }
  if (title.observed && title.indexed) {
    return { threadId: title.ids.length === 1 ? title.ids[0] : null, ambiguous: title.ids.length > 1, viewKnown: true, source: 'visible-document-title', confidence: title.ids.length === 1 ? title.stale ? 'cached-title' : 'title' : 'uncertain' };
  }
  if (navigation.known || navigation.ambiguous) return { ...navigation, viewKnown: navigation.known };
  return { threadId: null, ambiguous: false, viewKnown: false, source: null };
}
module.exports = { VisibleChat, resolveVisibleSelection };
