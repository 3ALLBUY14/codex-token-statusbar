'use strict';
const { usageOf, emptyUsage, localDay } = require('./metrics.cjs');
const { UUID } = require('./codex-ipc.cjs');
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
const unknownModel = '模型未记录';
const timing = value => Number.isFinite(value) && value >= 0 ? value : null;
const feature = source => /auto_review|guardian_review/.test(typeof source === 'string' ? source : '') ? 'review' : source && typeof source === 'object' && source.subagent ? 'subagent' : null;
const add = (to, from) => { for (const key of Object.keys(emptyUsage())) to[key] = to[key] === null || from[key] === null ? null : to[key] + from[key]; };
function cumulativeFloor(...values) {
  let total = null;
  for (const value of values) if (value && Number.isSafeInteger(value.total_tokens) && (!total || value.total_tokens > total.total_tokens)) total = value;
  return total ? { ...total } : null;
}
function retainHistory(report, baseline) {
  const recorded = { ...report.totals }, total = cumulativeFloor(recorded, baseline) ?? recorded;
  const history = emptyUsage();
  history.total_tokens = total.total_tokens - recorded.total_tokens;
  if (total.input_tokens >= recorded.input_tokens && total.output_tokens >= recorded.output_tokens) {
    history.input_tokens = total.input_tokens - recorded.input_tokens; history.output_tokens = total.output_tokens - recorded.output_tokens;
    history.cached_input_tokens = total.cached_input_tokens >= recorded.cached_input_tokens ? Math.min(history.input_tokens, total.cached_input_tokens - recorded.cached_input_tokens) : null;
    history.reasoning_output_tokens = total.reasoning_output_tokens >= recorded.reasoning_output_tokens ? Math.min(history.output_tokens, total.reasoning_output_tokens - recorded.reasoning_output_tokens) : null;
  } else { history.input_tokens = history.output_tokens = history.cached_input_tokens = history.reasoning_output_tokens = null; }
  if (history.total_tokens) {
    report.byModel.push({ model: '历史未归属（累计记录）', ...history, requests: null });
    report.bySource.push({ source: 'history', ...history, requests: null }); report.partial = true;
  }
  return { ...report, totals: total, recordedTotals: recorded, unassignedTokens: history.total_tokens };
}
function mergeResponse(old, record) {
  if (!old || old.owned !== record.owned) return { ...(!old || record.owned ? record : old) };
  const merged = { ...old, conflict: Boolean(old.conflict || record.conflict || JSON.stringify(old.usage) !== JSON.stringify(record.usage)) };
  if (old.model && record.model && old.model !== record.model) { merged.model = null; merged.modelAmbiguous = true; }
  else if (!old.model && !old.modelAmbiguous) merged.model = record.model;
  if ((record.cumulative?.total_tokens ?? 0) > (merged.cumulative?.total_tokens ?? 0)) merged.cumulative = record.cumulative;
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
    const record = { thread, response, usage, model, owned, timestamp, day: timestamp ? localDay(timestamp) : null, source, parent: owned ? this.parent : UUID.test(p.session_id ?? '') && p.session_id !== thread ? p.session_id : null, cumulative: usageOf(p.thread_token_usage) };
    Object.assign(record, {
      turnId: label(p.turn_id), durationMs: timing(p.duration_ms), firstTokenMs: timing(p.time_to_first_token_ms),
      cachedInput: p.usage.cached_input_tokens ?? null, reasoningOutput: p.usage.reasoning_output_tokens ?? null,
    });
    const key = thread + ':' + response, old = this.records.get(key);
    if (!old && this.records.size >= 100000) { this.limited = true; return; }
    this.records.set(key, mergeResponse(old, record));
  }
}
function buildUsageIndex(files, sessions) {
  const records = new Map(), bad = new Map(), parents = new Map(), groups = new Map(), legacyTotals = new Map();
  for (const tail of sessions) {
    const id = tail.accumulator.id, parent = tail.accumulator.parentId;
    if (UUID.test(parent ?? '')) parents.set(id, parent);
  }
  for (const tail of files) {
    if (tail.accumulator.hasUsage && UUID.test(tail.accumulator.id ?? '')) {
      const previous = legacyTotals.get(tail.accumulator.id);
      legacyTotals.set(tail.accumulator.id, cumulativeFloor(previous, tail.accumulator.totals) ?? previous ?? tail.accumulator.totals);
    }
    const ledger = tail.ledger;
    if (ledger.invalid || ledger.limited) bad.set(ledger.owner, true);
    for (const [key, record] of ledger.records) {
      records.set(key, mergeResponse(records.get(key), record));
      if (record.parent && !parents.has(record.thread)) parents.set(record.thread, record.parent);
    }
  }
  for (const record of records.values()) {
    let group = groups.get(record.thread);
    if (!group) { group = { totals: emptyUsage(), byModel: new Map(), bySource: new Map(), daily: new Map(), dailyModels: new Map(), records: [], requests: 0, partial: Boolean(bad.get(record.thread)), cumulative: 0, checkpoint: null, updatedAt: null }; groups.set(record.thread, group); }
    if (record.conflict) { group.partial = true; continue; }
    if (record.cumulative && ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens'].every(k => record.cumulative[k] >= record.usage[k])) {
      group.checkpoint = cumulativeFloor(group.checkpoint, record.cumulative) ?? group.checkpoint;
      group.cumulative = group.checkpoint?.total_tokens ?? 0;
    }
    if (!Number.isSafeInteger(group.totals.total_tokens + record.usage.total_tokens)) { group.partial = true; continue; }
    add(group.totals, record.usage); group.requests++; group.records.push(record);
    if (record.timestamp && (!group.updatedAt || Date.parse(record.timestamp) > Date.parse(group.updatedAt))) group.updatedAt = record.timestamp;
    const model = record.model ?? unknownModel, source = record.source;
    for (const [map, key] of [[group.byModel, model], [group.bySource, source]]) { const bucket = map.get(key) ?? { ...emptyUsage(), requests: 0 }; add(bucket, record.usage); bucket.requests++; map.set(key, bucket); }
    if (record.day) {
      const day = group.daily.get(record.day) ?? emptyUsage();
      add(day, record.usage); group.daily.set(record.day, day);
      const models = group.dailyModels.get(record.day) ?? new Map();
      models.set(model, (models.get(model) ?? 0) + record.usage.total_tokens);
      group.dailyModels.set(record.day, models);
    } else group.partial = true;
  }
  for (const group of groups.values()) group.partial ||= group.cumulative !== 0 && group.cumulative !== group.totals.total_tokens;
  return { groups, parents, bad, legacyTotals };
}
function accountingFor(id, index, sessions, previousTotals = new Map()) {
  const tails = new Map(sessions.map(t => [t.accumulator.id, t]));
  function own(thread) {
    const modern = index.groups.get(thread), legacy = tails.get(thread)?.snapshot(false);
    const source = index.parents.has(thread) ? 'subagent' : 'task';
    const report = modern
      ? { method: 'response', totals: { ...modern.totals }, requests: modern.requests, updatedAt: modern.updatedAt, partial: modern.partial, byModel: [...modern.byModel].map(([model, usage]) => ({ model, ...usage })), bySource: [...modern.bySource].map(([source, usage]) => ({ source, ...usage })) }
      : { method: 'legacy', totals: { ...(legacy?.totals ?? emptyUsage()) }, requests: null, partial: Boolean(index.bad.get(thread) || legacy?.usageIncomplete || legacy?.accountingWarning), byModel: legacy?.hasUsage ? [{ model: '旧格式未按模型归属', ...legacy.totals, requests: null }] : [], bySource: legacy?.hasUsage ? [{ source, ...legacy.totals, requests: null }] : [] };
    // A model change must not replace the chat's cumulative total with a partial request ledger.
    const result = retainHistory(report, cumulativeFloor(index.legacyTotals.get(thread), modern?.checkpoint, previousTotals.get(thread)));
    previousTotals.set(thread, { ...result.totals });
    return result;
  }
  const current = own(id), included = new Set([id]);
  for (const thread of new Set([...tails.keys(), ...index.groups.keys()])) {
    let cursor = thread; const seen = new Set();
    while (index.parents.has(cursor) && !seen.has(cursor)) { seen.add(cursor); cursor = index.parents.get(cursor); if (cursor === id) { included.add(thread); break; } }
  }
  const related = { totals: emptyUsage(), requests: 0, partial: false, unassignedTokens: 0, byModel: [], bySource: [] }, models = new Map(), sources = new Map();
  for (const thread of included) {
    const report = own(thread); if (!Number.isSafeInteger(related.totals.total_tokens + report.totals.total_tokens)) { related.partial = true; continue; } add(related.totals, report.totals); related.partial ||= report.partial;
    related.unassignedTokens += report.unassignedTokens;
    related.requests = related.requests === null || report.requests === null ? null : related.requests + report.requests;
    for (const [rows, map, field] of [[report.byModel, models, 'model'], [report.bySource, sources, 'source']]) for (const row of rows) { const bucket = map.get(row[field]) ?? { [field]: row[field], ...emptyUsage(), requests: 0 }; add(bucket, row); bucket.requests = bucket.requests === null || row.requests === null ? null : bucket.requests + row.requests; map.set(row[field], bucket); }
  }
  related.byModel = [...models.values()].sort((a, b) => b.total_tokens - a.total_tokens); related.bySource = [...sources.values()].sort((a, b) => b.total_tokens - a.total_tokens);
  return { ...current, related, relatedThreads: included.size - 1 };
}

function activityFor(index, tails, threadId, now = Date.now()) {
  const accumulators = new Map(tails.map(tail => [tail.accumulator.id, tail.accumulator]));
  const ids = threadId ? [threadId] : new Set([...accumulators.keys(), ...index.groups.keys()]);
  const end = localDay(now), start = new Date(now);
  start.setDate(start.getDate() - 364);
  const first = localDay(start), calendar = new Map();
  let partial = false;
  for (const id of ids) {
    const group = index.groups.get(id), accumulator = accumulators.get(id);
    const daily = group?.daily ?? accumulator?.daily;
    const checkpoint = index.legacyTotals.get(id)?.total_tokens ?? 0;
    let dated = 0;
    for (const [date, usage] of daily ?? []) {
      dated += usage.total_tokens;
      if (date < first || date > end) continue;
      const bucket = calendar.get(date) ?? { date, tokens: 0, models: new Map() };
      bucket.tokens += usage.total_tokens;
      const models = group?.dailyModels.get(date) ?? [[unknownModel, usage.total_tokens]];
      for (const [model, tokens] of models) bucket.models.set(model, (bucket.models.get(model) ?? 0) + tokens);
      calendar.set(date, bucket);
    }
    partial ||= Boolean(group?.partial || index.bad.has(id) || dated < Math.max(checkpoint, group?.totals.total_tokens ?? 0) ||
      (!group && (accumulator?.usageIncomplete || accumulator?.accountingWarning)));
  }
  const days = [...calendar.values()].sort((a, b) => a.date.localeCompare(b.date)).map(({ date, tokens, models }) => ({
    date, tokens, byModel: [...models].map(([model, tokens]) => ({ model, tokens })),
  }));
  return { days, partial };
}

const requestDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && localDay(`${value}T12:00:00`) === value ? value : '';
function requestPage(group, filters = {}) {
  const { model, start, end, page } = filters ?? {};
  const from = requestDate(start), to = requestDate(end), size = 20;
  const models = [...(group?.byModel.keys() ?? [])].sort();
  const selectedModel = models.includes(model) ? model : '';
  if (group && !group.sortedRecords) {
    group.sortedRecords = [...group.records].sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  }
  const matching = (group?.sortedRecords ?? []).filter(row => (!selectedModel || (row.model ?? unknownModel) === selectedModel) &&
    (!(from || to) || (row.day && (!from || row.day >= from) && (!to || row.day <= to))));
  const pages = Math.max(1, Math.ceil(matching.length / size));
  const index = Number.isSafeInteger(page) ? Math.min(pages - 1, Math.max(0, page)) : 0;
  const records = matching.slice(index * size, (index + 1) * size).map(row => ({
    id: row.response, turnId: row.turnId, timestamp: row.timestamp, model: row.model ?? unknownModel, durationMs: row.durationMs, firstTokenMs: row.firstTokenMs,
    usage: { ...row.usage, cached_input_tokens: row.cachedInput, reasoning_output_tokens: row.reasoningOutput },
  }));
  return { records, models, model: selectedModel, page: index, pages, matches: matching.length, total: group?.requests ?? 0 };
}
module.exports = { ResponseLedger, buildUsageIndex, accountingFor, activityFor, requestPage };
