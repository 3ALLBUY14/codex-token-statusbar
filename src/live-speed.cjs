'use strict';
let tokenizer;
function countTokens(text) {
  if (!tokenizer) {
    const { Tiktoken } = require('js-tiktoken/lite');
    tokenizer = new Tiktoken(require('js-tiktoken/ranks/o200k_base'));
  }
  return tokenizer.encode(text, [], []).length;
}
class LiveSpeed {
  constructor({ now = Date.now, count = countTokens } = {}) { this.now = now; this.count = count; this.select(null); }
  select(id) {
    if (id === this.id && this.items) return;
    this.id = id; this.clear();
  }
  clear() { this.items = new Map(); this.samples = []; this.firstAt = null; this.lastAt = null; this.revision = null; this.available = true; }
  remember(key, state) { this.items.set(key, state); if (this.items.size > 32) this.items.delete(this.items.keys().next().value); }
  ingest(change) {
    if (!this.id || !change || !Number.isSafeInteger(change.revision) || change.revision < 0) return;
    if (change.type === 'snapshot') { this.clear(); this.revision = change.revision; return; }
    if (change.type !== 'patches' || !Number.isSafeInteger(change.baseRevision) || change.baseRevision < 0 || change.revision <= change.baseRevision || this.revision !== null && change.revision <= this.revision) return;
    if (this.revision !== null && change.baseRevision !== this.revision) { this.clear(); this.revision = change.revision; return; }
    this.revision = change.revision;
    const now = this.now();
    if (this.lastAt !== null && (now < this.lastAt || now - this.lastAt > 2000)) { this.samples = []; this.firstAt = null; }
    if (!Array.isArray(change.acceptedTextChanges) || change.acceptedTextChanges.length > 256) return;
    for (const item of change.acceptedTextChanges) {
      // Ignore reasoning, tools, full snapshots, replacements and historical text.
      if (item?.type !== 'text' || item.target?.field !== 'text' || !Array.isArray(item.edits) || item.edits.length > 64) continue;
      const { entityKey, itemId, threadId } = item.key ?? {};
      if (threadId !== this.id || typeof entityKey !== 'string' || entityKey.length > 512 || typeof itemId !== 'string' || itemId.length > 256) continue;
      const key = entityKey + '\u001f' + itemId;
      for (const edit of item.edits) {
        if (!edit || !Number.isSafeInteger(edit.at) || edit.at < 0 || edit.deleteCount !== 0 || typeof edit.insert !== 'string' || edit.insert.length > 4096) {
          this.items.delete(key); this.samples = []; this.firstAt = null; continue;
        }
        let state = this.items.get(key);
        const known = Boolean(state);
        if (!state || state.offset !== edit.at) {
          state = { offset: edit.at, suffix: '' };
          if (known || edit.at !== 0) { state.offset += edit.insert.length; state.suffix = edit.insert.slice(-512); this.remember(key, state); this.samples = []; this.firstAt = null; continue; }
        }
        if (!edit.insert) continue;
        let tokens;
        try { tokens = Math.max(0, this.count(state.suffix + edit.insert) - this.count(state.suffix)); }
        catch { this.available = false; this.samples = []; return; }
        state.offset += edit.insert.length; state.suffix = (state.suffix + edit.insert).slice(-512);
        this.remember(key, state);
        this.firstAt ??= now; this.lastAt = now;
        this.samples.push({ at: now, tokens });
      }
    }
    this.samples = this.samples.filter(s => now - s.at <= 5000).slice(-512);
  }
  snapshot() {
    const now = this.now(), elapsed = this.firstAt === null ? 0 : now - this.firstAt;
    if (!this.available || this.lastAt === null || now < this.lastAt || now - this.lastAt > 2000 || elapsed < 750 || this.samples.length < 2) return { tokensPerSecond: null, status: this.available ? 'waiting' : 'unavailable', kind: 'visible-output-estimate' };
    const tokens = this.samples.filter(s => now - s.at <= 5000).reduce((n, s) => n + s.tokens, 0);
    return { tokensPerSecond: tokens > 0 ? tokens * 1000 / Math.min(5000, elapsed) : null, status: tokens > 0 ? 'streaming' : 'waiting', kind: 'visible-output-estimate', windowMs: Math.min(5000, elapsed) };
  }
}
module.exports = { LiveSpeed, countTokens };
