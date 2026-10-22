'use strict';
const { usageOf, emptyUsage, localDay } = require('./metrics.cjs');
const { UUID } = require('./codex-ipc.cjs');
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
const feature = source => /auto_review|guardian_review/.test(typeof source === 'string' ? source : '') ? 'review' : source && typeof source === 'object' && source.subagent ? 'subagent' : null;
const add = (to, from) => { for (const key of Object.keys(emptyUsage())) to[key] += from[key]; };
function mergeResponse(old, record) {
  if (!old || old.owned !== record.owned) return { ...(!old || record.owned ? record : old) };
  const merged = { ...old, conflict: Boolean(old.conflict || record.conflict || JSON.stringify(old.usage) !== JSON.stringify(record.usage)) };
  if (old.model && record.model && old.model !== record.model) { merged.model = null; merged.modelAmbiguous = true; }
  else if (!old.model && !old.modelAmbiguous) merged.model = record.model;
  return merged;
}
class ResponseLedger {
  constructor() { this.owner = null; this.parent = null; this.feature = null; this.model = null; this.models = new Map(); this.records = new Map(); this.invalid = 0; this.limited = false; }
  feed(row) {
    const p = row?.payload; if (!p || typeof p !== 'object') return;
    if (row.type === 'session_meta') {
      if (UUID.test(p.id ?? '')) this.owner = p.id;
      const parent = p.source?.subagent?.thread_spawn?.parent_thread_id ?? p.parent_thread_id;
      this.parent = UUID.test(parent ?? '') ? parent : null; this.feature = feature(p.source); return;
    }
    if (row.type === 'turn_context') {
      this.model = label(p.model);
      if (label(p.turn_id) && this.model && (this.models.has(p.turn_id) || this.models.size < 10000)) { const models = this.models.get(p.turn_id) ?? new Set(); if (models.size < 16) models.add(this.model); this.models.set(p.turn_id, models); }
      return;
    }
    if (row.type === 'event_msg' && p.type === 'thread_settings_applied') { this.model = label(p.thread_settings?.model) ?? this.model; return; }
    if (row.type !== 'token_usage_record') return;
    const usage = usageOf(p.usage), thread = p.thread_id, response = label(p.response_id);
    if (!UUID.test(thread ?? '') || !response || !usage || !p.usage || !Number.isSafeInteger(p.usage.input_tokens) || !Number.isSafeInteger(p.usage.output_tokens)) { this.invalid++; return; }
    if (p.usage.total_tokens !== undefined && p.usage.total_tokens !== usage.total_tokens) { this.invalid++; return; }
    const owned = thread === this.owner, models = this.models.get(p.turn_id);
    const model = label(p.model) ?? label(p.model_name) ?? (owned ? models?.size === 1 ? [...models][0] : models?.size > 1 ? null : this.model : null);
    const timestamp = typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : null;
    const source = feature(p.thread_source) ?? (owned ? this.feature : null) ?? (p.thread_source === 'subagent' || UUID.test(p.session_id ?? '') && thread !== p.session_id ? 'subagent' : owned || p.session_id === thread ? 'task' : 'unknown');
    const record = { thread, response, usage, model, owned, timestamp, day: localDay(row.timestamp), source, parent: owned ? this.parent : UUID.test(p.session_id ?? '') && p.session_id !== thread ? p.session_id : null, cumulative: usageOf(p.thread_token_usage) };
    const key = thread + ':' + response, old = this.records.get(key);
    if (!old && this.records.size >= 100000) { this.limited = true; return; }
    this.records.set(key, mergeResponse(old, record));
  }
}
function buildUsageIndex(files, sessions) {
  const records = new Map(), bad = new Map(), parents = new Map(), groups = new Map();
  for (const tail of sessions) {
    const id = tail.accumulator.id, parent = tail.accumulator.parentId;
    if (UUID.test(parent ?? '')) parents.set(id, parent);
  }
  for (const tail of files) {
    const ledger = tail.ledger;
    if (ledger.invalid || ledger.limited) bad.set(ledger.owner, true);
    for (const [key, record] of ledger.records) {
      records.set(key, mergeResponse(records.get(key), record));
      if (record.parent && !parents.has(record.thread)) parents.set(record.thread, record.parent);
    }
  }
  for (const record of records.values()) {
    let group = groups.get(record.thread);
    if (!group) { group = { totals: emptyUsage(), byModel: new Map(), bySource: new Map(), daily: new Map(), requests: 0, partial: Boolean(bad.get(record.thread)), cumulative: 0, updatedAt: null }; groups.set(record.thread, group); }
    group.cumulative = Math.max(group.cumulative, record.cumulative?.total_tokens ?? 0);
    if (record.conflict) { group.partial = true; continue; }
    if (!Number.isSafeInteger(group.totals.total_tokens + record.usage.total_tokens)) { group.partial = true; continue; }
    add(group.totals, record.usage); group.requests++;
    if (record.timestamp && (!group.updatedAt || Date.parse(record.timestamp) > Date.parse(group.updatedAt))) group.updatedAt = record.timestamp;
    const model = record.model ?? '模型未记录', source = record.source;
    for (const [map, key] of [[group.byModel, model], [group.bySource, source]]) { const bucket = map.get(key) ?? { ...emptyUsage(), requests: 0 }; add(bucket, record.usage); bucket.requests++; map.set(key, bucket); }
    if (record.day) { const day = group.daily.get(record.day) ?? emptyUsage(); add(day, record.usage); group.daily.set(record.day, day); } else group.partial = true;
  }
  for (const group of groups.values()) group.partial ||= group.cumulative !== 0 && group.cumulative !== group.totals.total_tokens;
  return { groups, parents, bad };
}
function accountingFor(id, index, sessions) {
  const tails = new Map(sessions.map(t => [t.accumulator.id, t]));
  function own(thread) {
    const modern = index.groups.get(thread), legacy = tails.get(thread)?.snapshot(false);
    if (modern) return { method: 'response', totals: { ...modern.totals }, requests: modern.requests, updatedAt: modern.updatedAt, partial: modern.partial || Boolean(legacy?.totals.total_tokens > modern.totals.total_tokens), byModel: [...modern.byModel].map(([model, usage]) => ({ model, ...usage })), bySource: [...modern.bySource].map(([source, usage]) => ({ source, ...usage })) };
    const source = index.parents.has(thread) ? 'subagent' : 'task';
    return { method: 'legacy', totals: { ...(legacy?.totals ?? emptyUsage()) }, requests: null, partial: Boolean(index.bad.get(thread) || legacy?.usageIncomplete || legacy?.accountingWarning), byModel: legacy?.hasUsage ? [{ model: '旧格式未按模型归属', ...legacy.totals, requests: null }] : [], bySource: legacy?.hasUsage ? [{ source, ...legacy.totals, requests: null }] : [] };
  }
  const current = own(id), included = new Set([id]);
  for (const thread of new Set([...tails.keys(), ...index.groups.keys()])) {
    let cursor = thread; const seen = new Set();
    while (index.parents.has(cursor) && !seen.has(cursor)) { seen.add(cursor); cursor = index.parents.get(cursor); if (cursor === id) { included.add(thread); break; } }
  }
  const related = { totals: emptyUsage(), requests: 0, partial: false, byModel: [], bySource: [] }, models = new Map(), sources = new Map();
  for (const thread of included) {
    const report = own(thread); if (!Number.isSafeInteger(related.totals.total_tokens + report.totals.total_tokens)) { related.partial = true; continue; } add(related.totals, report.totals); related.partial ||= report.partial;
    related.requests = related.requests === null || report.requests === null ? null : related.requests + report.requests;
    for (const [rows, map, field] of [[report.byModel, models, 'model'], [report.bySource, sources, 'source']]) for (const row of rows) { const bucket = map.get(row[field]) ?? { [field]: row[field], ...emptyUsage(), requests: 0 }; add(bucket, row); bucket.requests = bucket.requests === null || row.requests === null ? null : bucket.requests + row.requests; map.set(row[field], bucket); }
  }
  related.byModel = [...models.values()].sort((a, b) => b.total_tokens - a.total_tokens); related.bySource = [...sources.values()].sort((a, b) => b.total_tokens - a.total_tokens);
  return { ...current, related, relatedThreads: included.size - 1 };
}
module.exports = { ResponseLedger, buildUsageIndex, accountingFor };
