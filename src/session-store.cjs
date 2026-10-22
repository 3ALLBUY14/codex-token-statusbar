'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { SessionAccumulator, JsonlDecoder, emptyUsage, localDay } = require('./metrics.cjs');
const { UUID } = require('./codex-ipc.cjs');
const { StatisticsCache, fingerprint } = require('./statistics-cache.cjs');
const { ResponseLedger, buildUsageIndex, accountingFor } = require('./response-usage.cjs');
const CACHE_VERSION = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'metrics.cjs'))).update(fs.readFileSync(path.join(__dirname, 'response-usage.cjs'))).update('snapshot-v2:' + Intl.DateTimeFormat().resolvedOptions().timeZone).digest('hex');

const CHUNK = 256 * 1024;
const MAX_PASS_BYTES = 64 * 1024 * 1024;

function codexHome() { return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')); }

class FileTail {
  constructor(filename, saved = null) { this.filename = filename; this.reset(); this.saved = saved; }
  reset() {
    this.offset = 0;
    this.mtimeMs = 0;
    this.identity = null;
    this.saved = null;
    this.fingerprint = null;
    this.complete = false;
    this.accumulator = new SessionAccumulator();
    this.ledger = new ResponseLedger();
    this.decoder = new JsonlDecoder(line => this.ledger.feed(this.accumulator.processLine(line)));
    this.cachedSnapshots = new Map();
  }
  async refresh(budget = MAX_PASS_BYTES) {
    let handle;
    try {
      handle = await fsp.open(this.filename, 'r');
      const stat = await handle.stat();
      const identity = `${stat.dev}:${stat.ino}`;
      if (this.saved) {
        const saved = this.saved;
        if (stat.size === saved.size && stat.mtimeMs === saved.mtimeMs && identity === saved.identity && await fingerprint(handle, stat.size) === saved.fingerprint) {
          this.offset = stat.size; this.mtimeMs = stat.mtimeMs; this.identity = identity; this.fingerprint = saved.fingerprint; this.complete = true;
          this.decoder.skippedLines = saved.skippedLines;
          Object.assign(this.accumulator, { id: saved.snapshot.threadId, parentId: saved.parentId ?? null, model: saved.snapshot.model, source: saved.isRootDesktop ? 'desktop' : null, totals: saved.snapshot.totals, hasUsage: saved.snapshot.hasUsage, accountingWarning: saved.snapshot.accountingWarning, usageIncomplete: saved.snapshot.usageIncomplete, daily: new Map(saved.daily) });
          return { consumed: 0, pending: false, error: null, cacheHit: true };
        }
        // A snapshot cannot resume parsing. Rebuild only the changed file.
        this.reset();
      }
      if ((this.identity && this.identity !== identity) || stat.size < this.offset) this.reset();
      if (stat.size === this.offset && this.mtimeMs && stat.mtimeMs !== this.mtimeMs) this.reset();
      this.identity = identity;
      this.mtimeMs = stat.mtimeMs;
      const snapshotSize = stat.size;
      if (snapshotSize === this.offset) return { consumed: 0, pending: false, error: null };
      this.cachedSnapshots.clear();
      let consumed = 0;
      this.complete = false;
      const buffer = Buffer.alloc(CHUNK);
      while (this.offset < snapshotSize && consumed < budget) {
        const length = Math.min(CHUNK, snapshotSize - this.offset, budget - consumed);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        if (!bytesRead) break;
        this.decoder.push(buffer.subarray(0, bytesRead));
        this.cachedSnapshots.clear();
        this.offset += bytesRead;
        consumed += bytesRead;
        await new Promise(resolve => setImmediate(resolve));
      }
      this.complete = this.offset === snapshotSize && !this.decoder.pending && !this.decoder.dropping && !this.decoder.decoder.lastNeed;
      if (this.complete) this.fingerprint = await fingerprint(handle, snapshotSize);
      return { consumed, pending: this.offset < snapshotSize, error: null };
    } catch (error) {
      return { consumed: 0, pending: false, error: error.code ?? 'read-error' };
    } finally { await handle?.close(); }
  }
  snapshot(includeRecords = true) {
    if (this.saved) {
      const snapshot = structuredClone(this.saved.snapshot);
      if (!includeRecords) {
        for (const stats of [snapshot.toolUsage, snapshot.turnToolUsage, snapshot.lastTurn?.toolUsage]) if (stats) stats.records = [];
        snapshot.runningTools = []; snapshot.turnRunningTools = [];
      }
      return snapshot;
    }
    if (!this.cachedSnapshots.has(includeRecords)) this.cachedSnapshots.set(includeRecords, this.accumulator.snapshot(includeRecords));
    return this.cachedSnapshots.get(includeRecords);
  }
  checkpoint() {
    if (this.saved && this.complete) return this.saved;
    // Response identities must be replayed for cross-file deduplication.
    if (this.ledger.records.size || this.ledger.invalid || this.ledger.limited) return null;
    if (!this.complete || !this.fingerprint || this.accumulator.activeTurn || !UUID.test(this.accumulator.id ?? '')) return null;
    return { size: this.offset, mtimeMs: this.mtimeMs, identity: this.identity, fingerprint: this.fingerprint, snapshot: this.snapshot(), parentId: this.accumulator.parentId, isRootDesktop: this.accumulator.isRootDesktop, daily: [...this.accumulator.daily], skippedLines: this.decoder.skippedLines };
  }
}

async function discover(root, maxFiles = 8192) {
  const filenames = [];
  const queue = [root];
  let truncated = false;
  const failedDirectories = [];
  while (queue.length) {
    const directory = queue.shift();
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') failedDirectories.push(directory); continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(filename);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        filenames.push(filename);
        if (filenames.length >= maxFiles) { truncated = true; return { filenames, truncated, failedDirectories: [...failedDirectories, root] }; }
      }
    }
  }
  return { filenames, truncated, failedDirectories };
}

class SessionStore extends EventEmitter {
  constructor(home = codexHome(), { cacheDirectory = null } = {}) {
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
    this.dirty = new Set();
    this.needsDiscovery = true;
    this.active = true;
    this.lastDiscovery = 0;
    this.cursor = 0;
    this.fileErrors = new Map();
    this.cache = cacheDirectory ? new StatisticsCache(cacheDirectory, this.home, CACHE_VERSION) : null;
    this.cacheLoaded = false; this.cacheHits = 0; this.cacheDirty = false; this.cacheTimer = null; this.cacheWriting = null; this.cacheNextAt = 0;
  }
  setActive(active) { this.active = Boolean(active); }
  async start() {
    for (const root of this.roots) {
      try {
        const watcher = fs.watch(root, { recursive: true }, (_, filename) => {
          if (filename && !String(filename).endsWith('.jsonl')) return;
          const changed = filename ? path.resolve(root, String(filename)) : null;
          if (!changed || !this.files.has(changed)) this.needsDiscovery = true;
          if (changed) this.dirty.add(changed);
          clearTimeout(this.debounce);
          this.debounce = setTimeout(() => this.scan(false), this.active ? 300 : 1500);
        });
        watcher.on('error', () => {});
        this.watchers.push(watcher);
      } catch {}
    }
    await this.scan();
    // Reconcile missed file notifications and directories created after startup.
    this.scanTimer = setInterval(() => { if (Date.now() - this.lastDiscovery >= (this.active ? 15000 : 60000)) void this.scan(); }, 5000);
  }
  async scan(full = true) {
    if (this.stopped) return;
    if (this.busy) { this.rescanRequested = true; this.needsDiscovery ||= full; return; }
    this.busy = true;
    try {
      if (this.cache && !this.cacheLoaded) { await this.cache.load(); this.cacheLoaded = true; }
      full ||= this.needsDiscovery;
      let failedDirectories = [];
      let present;
      if (full) {
        this.needsDiscovery = false;
        const discovered = await Promise.all(this.roots.map(root => discover(root)));
        this.truncated = discovered.some(result => result.truncated);
        failedDirectories = discovered.flatMap(result => result.failedDirectories);
        this.directoryErrors = failedDirectories.length;
        present = new Set(discovered.flatMap(result => result.filenames));
        for (const filename of this.files.keys()) if (!present.has(filename)) {
          if (failedDirectories.some(directory => filename.startsWith(directory + path.sep))) continue;
          this.files.delete(filename); this.cacheDirty = true;
          this.fileErrors.delete(filename);
        }
        this.lastDiscovery = Date.now();
      } else present = new Set([...this.dirty].filter(filename => this.files.has(filename)));
      this.dirty.clear();
      let budget = MAX_PASS_BYTES;
      let pending = false;
      const filenames = [...present];
      const offset = full && filenames.length ? this.cursor % filenames.length : 0;
      const ordered = [...filenames.slice(offset), ...filenames.slice(0, offset)];
      this.readErrors = this.directoryErrors ?? 0;
      for (const filename of ordered) {
        let tail = this.files.get(filename);
        if (!tail) { tail = new FileTail(filename, this.cache?.take(filename)); this.files.set(filename, tail); }
        if (budget <= 0) { pending = true; this.needsDiscovery = true; break; }
        const wasCached = tail.complete && Boolean(tail.saved);
        const result = await tail.refresh(budget);
        if (result.cacheHit && !wasCached) this.cacheHits++;
        if (result.consumed) this.cacheDirty = true;
        budget -= result.consumed;
        pending ||= result.pending;
        if (result.error) this.fileErrors.set(filename, result.error);
        else this.fileErrors.delete(filename);
        if (result.error === 'ENOENT') this.needsDiscovery = true;
      }
      if (full && filenames.length) this.cursor = (offset + 1) % filenames.length;
      this.readErrors = (this.directoryErrors ?? 0) + this.fileErrors.size;
      this.indexing = pending;
      this.revision++;
      this.emit('updated');
      if (this.cache && this.cacheDirty && !pending && !this.stopped && !this.cacheTimer) this.cacheTimer = setTimeout(() => { this.cacheTimer = null; void this.flushCache(); }, Math.max(3000, this.cacheNextAt - Date.now()));
      if (pending) this.rescanRequested = true;
    } finally {
      this.busy = false;
      if (this.rescanRequested && !this.stopped) {
        this.rescanRequested = false;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.scan(this.indexing), this.indexing ? 100 : 300);
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
  snapshot(settings = {}, ipc = {}, { includeRecords = true, includeSessions = true } = {}) {
    const sessions = this.sessions();
    if (this.usageIndexRevision !== this.revision || !this.usageIndex) { this.usageIndex = buildUsageIndex(this.files.values(), sessions); this.usageIndexRevision = this.revision; this.accountingCache = new Map(); }
    const usageIndex = this.usageIndex;
    const day = localDay(Date.now());
    const today = emptyUsage();
    for (const tail of sessions) {
      const bucket = usageIndex.groups.get(tail.accumulator.id)?.daily.get(day) ?? (!usageIndex.groups.has(tail.accumulator.id) ? tail.accumulator.daily.get(day) : null);
      if (bucket) for (const key of Object.keys(today)) today[key] += bucket[key];
    }
    const known = new Set(sessions.map(t => t.accumulator.id));
    for (const [id, group] of usageIndex.groups) if (!known.has(id)) { const bucket = group.daily.get(day); if (bucket) for (const key of Object.keys(today)) today[key] += bucket[key]; }
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
    const session = selected ? structuredClone(selected.snapshot(includeRecords)) : null;
    if (session) {
      if (!this.accountingCache.has(selectedId)) this.accountingCache.set(selectedId, accountingFor(selectedId, usageIndex, sessions));
      session.accounting = structuredClone(this.accountingCache.get(selectedId));
      if (session.accounting.method === 'response') {
        session.totals = { ...session.accounting.totals }; session.hasUsage = session.accounting.requests > 0;
        if (session.accounting.updatedAt && (!session.updatedAt || Date.parse(session.accounting.updatedAt) > Date.parse(session.updatedAt))) session.updatedAt = session.accounting.updatedAt;
        session.cacheHitPercent = session.totals.input_tokens ? session.totals.cached_input_tokens * 100 / session.totals.input_tokens : null;
      }
    }
    return {
      session,
      selection: { mode, threadId: selectedId, source: ipc.source ?? null, confidence: mode === 'pinned' ? 'manual' : ipc.confidence ?? 'unknown', reason: ipc.reason ?? null, connected: Boolean(ipc.connected), routeCount: ipc.routeCount ?? 0 },
      today: { day, usage: today, partial: this.indexing || this.truncated || this.readErrors > 0 || usageIndex.bad.size > 0 || [...usageIndex.groups.values()].some(g => g.partial) || sessions.some(tail => tail.accumulator.accountingWarning || tail.accumulator.usageIncomplete || tail.decoder.skippedLines > 0) },
      sessions: includeSessions ? sessions.filter(tail => tail.accumulator.isRootDesktop).map(tail => ({
        id: tail.accumulator.id,
        model: tail.accumulator.model,
        tokens: tail.accumulator.hasUsage ? tail.accumulator.totals.total_tokens : null,
        active: Boolean(tail.accumulator.activeTurn),
      })) : [],
      health: { fileCount: this.files.size, sessionCount: sessions.length, indexing: this.indexing, truncated: this.truncated, readErrors: this.readErrors, cacheHits: this.cacheHits, cacheError: this.cache?.error ?? null },
    };
  }
  async flushCache() {
    if (!this.cache || !this.cacheDirty || this.busy) return;
    if (this.cacheWriting) return this.cacheWriting;
    this.cacheDirty = false;
    this.cacheNextAt = Date.now() + 30000;
    this.cacheWriting = this.cache.save(this.files);
    await this.cacheWriting; this.cacheWriting = null;
    if (this.cache.error) this.cacheDirty = true;
    this.emit('updated');
  }
  stop() {
    this.stopped = true;
    clearInterval(this.scanTimer);
    clearTimeout(this.debounce);
    clearTimeout(this.cacheTimer);
    for (const watcher of this.watchers) watcher.close();
  }
}

module.exports = { SessionStore, FileTail, discover, codexHome };
