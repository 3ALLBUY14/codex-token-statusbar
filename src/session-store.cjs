'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { SessionAccumulator, JsonlDecoder, emptyUsage, localDay } = require('./metrics.cjs');
const { UUID } = require('./codex-ipc.cjs');

const CHUNK = 256 * 1024;
const MAX_PASS_BYTES = 64 * 1024 * 1024;

function codexHome() { return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')); }

class FileTail {
  constructor(filename) { this.filename = filename; this.reset(); }
  reset() {
    this.offset = 0;
    this.mtimeMs = 0;
    this.identity = null;
    this.accumulator = new SessionAccumulator();
    this.decoder = new JsonlDecoder(line => this.accumulator.processLine(line));
  }
  async refresh(budget = MAX_PASS_BYTES) {
    let handle;
    try {
      handle = await fsp.open(this.filename, 'r');
      const stat = await handle.stat();
      const identity = `${stat.dev}:${stat.ino}`;
      if ((this.identity && this.identity !== identity) || stat.size < this.offset) this.reset();
      this.identity = identity;
      this.mtimeMs = stat.mtimeMs;
      const snapshotSize = stat.size;
      let consumed = 0;
      const buffer = Buffer.alloc(CHUNK);
      while (this.offset < snapshotSize && consumed < budget) {
        const length = Math.min(CHUNK, snapshotSize - this.offset, budget - consumed);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        if (!bytesRead) break;
        this.decoder.push(buffer.subarray(0, bytesRead));
        this.offset += bytesRead;
        consumed += bytesRead;
        await new Promise(resolve => setImmediate(resolve));
      }
      return { consumed, pending: this.offset < snapshotSize, error: null };
    } catch (error) {
      return { consumed: 0, pending: false, error: error.code ?? 'read-error' };
    } finally { await handle?.close(); }
  }
}

async function discover(root, maxFiles = 8192) {
  const filenames = [];
  const queue = [root];
  let truncated = false;
  while (queue.length) {
    const directory = queue.shift();
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(filename);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        filenames.push(filename);
        if (filenames.length >= maxFiles) { truncated = true; return { filenames, truncated }; }
      }
    }
  }
  return { filenames, truncated };
}

class SessionStore extends EventEmitter {
  constructor(home = codexHome()) {
    super();
    this.home = path.resolve(home);
    this.roots = [path.join(this.home, 'sessions'), path.join(this.home, 'archived_sessions')];
    this.files = new Map();
    this.watchers = [];
    this.scanTimer = null;
    this.debounce = null;
    this.busy = false;
    this.rescanRequested = false;
    this.stopped = false;
    this.indexing = false;
    this.truncated = false;
    this.readErrors = 0;
    this.revision = 0;
  }
  async start() {
    for (const root of this.roots) {
      try {
        const watcher = fs.watch(root, { recursive: true }, (_, filename) => {
          if (filename && !String(filename).endsWith('.jsonl')) return;
          clearTimeout(this.debounce);
          this.debounce = setTimeout(() => this.scan(), 300);
        });
        watcher.on('error', () => {});
        this.watchers.push(watcher);
      } catch {}
    }
    await this.scan();
    // Reconcile missed file notifications and directories created after startup.
    this.scanTimer = setInterval(() => this.scan(), 15000);
  }
  async scan() {
    if (this.stopped) return;
    if (this.busy) { this.rescanRequested = true; return; }
    this.busy = true;
    try {
      const discovered = await Promise.all(this.roots.map(root => discover(root)));
      this.truncated = discovered.some(result => result.truncated);
      const present = new Set(discovered.flatMap(result => result.filenames));
      for (const filename of this.files.keys()) if (!present.has(filename)) this.files.delete(filename);
      let budget = MAX_PASS_BYTES;
      let pending = false;
      this.readErrors = 0;
      for (const filename of present) {
        let tail = this.files.get(filename);
        if (!tail) { tail = new FileTail(filename); this.files.set(filename, tail); }
        if (budget <= 0) { pending = true; break; }
        const result = await tail.refresh(budget);
        budget -= result.consumed;
        pending ||= result.pending;
        if (result.error) this.readErrors++;
      }
      this.indexing = pending;
      this.revision++;
      this.emit('updated');
      if (pending) this.rescanRequested = true;
    } finally {
      this.busy = false;
      if (this.rescanRequested && !this.stopped) {
        this.rescanRequested = false;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.scan(), this.indexing ? 100 : 300);
      }
    }
  }
  sessions() {
    const byId = new Map();
    for (const tail of this.files.values()) {
      const id = tail.accumulator.id;
      if (!id || !UUID.test(id)) continue;
      const previous = byId.get(id);
      if (!previous || tail.mtimeMs > previous.mtimeMs) byId.set(id, tail);
    }
    return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
  snapshot(settings = {}, ipc = {}) {
    const sessions = this.sessions();
    const day = localDay(Date.now());
    const today = emptyUsage();
    for (const tail of sessions) {
      const bucket = tail.accumulator.daily.get(day);
      if (bucket) for (const key of Object.keys(today)) today[key] += bucket[key];
    }
    let mode = 'unbound';
    let selectedId = null;
    let selected;
    if (settings.pinnedThreadId && UUID.test(settings.pinnedThreadId)) {
      selectedId = settings.pinnedThreadId;
      mode = 'pinned';
    } else if (ipc.ambiguous) {
      mode = 'ambiguous';
    } else if (ipc.threadId && UUID.test(ipc.threadId)) {
      selectedId = ipc.threadId;
      mode = 'following';
    } else if (ipc.viewKnown) {
      mode = 'empty';
    } else {
      selected = sessions.find(tail => tail.accumulator.isRootDesktop);
      selectedId = selected?.accumulator.id ?? null;
      mode = selected ? 'recent' : 'unbound';
    }
    selected ??= selectedId ? sessions.find(tail => tail.accumulator.id === selectedId) : null;
    return {
      session: selected?.accumulator.snapshot() ?? null,
      selection: { mode, threadId: selectedId, source: ipc.source ?? null, connected: Boolean(ipc.connected), routeCount: ipc.routeCount ?? 0 },
      today: { day, usage: today, partial: this.indexing || this.truncated || this.readErrors > 0 || sessions.some(tail => tail.accumulator.accountingWarning || tail.accumulator.usageIncomplete || tail.decoder.skippedLines > 0) },
      sessions: sessions.filter(tail => tail.accumulator.isRootDesktop).slice(0, 30).map(tail => ({
        id: tail.accumulator.id,
        model: tail.accumulator.model,
        tokens: tail.accumulator.hasUsage ? tail.accumulator.totals.total_tokens : null,
        active: Boolean(tail.accumulator.activeTurn),
      })),
      health: { fileCount: this.files.size, sessionCount: sessions.length, indexing: this.indexing, truncated: this.truncated, readErrors: this.readErrors },
    };
  }
  stop() {
    this.stopped = true;
    clearInterval(this.scanTimer);
    clearTimeout(this.debounce);
    for (const watcher of this.watchers) watcher.close();
  }
}

module.exports = { SessionStore, FileTail, discover, codexHome };
