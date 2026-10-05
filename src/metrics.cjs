'use strict';

const { StringDecoder } = require('node:string_decoder');
const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const TOOL_LABELS = Object.freeze({ CommandExecution: '命令执行', FileChange: '文件修改', Extension: '扩展操作', ImageView: '图像查看' });
const TOOL_RECORD_LIMIT = 200;
const emptyUsage = () => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 });
const emptyToolStats = () => ({ total: 0, failed: 0, durationMs: 0, timed: 0, byType: new Map(), records: [] });
const toolSnapshot = stats => ({ total: stats.total, failed: stats.failed, durationMs: stats.durationMs, timed: stats.timed, byType: [...stats.byType.values()].map(group => ({ ...group })), records: stats.records.map(record => ({ ...record })) });

function addTool(stats, item, failed, durationMs, timestamp) {
  const group = stats.byType.get(item.type) ?? { type: item.type, label: TOOL_LABELS[item.type], total: 0, failed: 0, durationMs: 0, timed: 0 };
  stats.total++;
  group.total++;
  if (failed) { stats.failed++; group.failed++; }
  if (durationMs !== null) { stats.durationMs += durationMs; stats.timed++; group.durationMs += durationMs; group.timed++; }
  stats.byType.set(item.type, group);
  // Retain only bounded, structured metadata; never command arguments or output.
  stats.records.push({
    sequence: stats.total, type: item.type, label: TOOL_LABELS[item.type],
    status: failed ? 'failed' : 'completed', durationMs,
    timestamp: typeof timestamp === 'string' && timestamp.length <= 64 && Number.isFinite(Date.parse(timestamp)) ? timestamp : null,
    exitCode: Number.isSafeInteger(item.exit_code) ? item.exit_code : null,
  });
  if (stats.records.length > TOOL_RECORD_LIMIT) stats.records.shift();
}

function usageOf(value) {
  if (!value || typeof value !== 'object') return null;
  const usage = emptyUsage();
  for (const key of TOKEN_FIELDS) {
    const count = value[key] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) return null;
    usage[key] = count;
  }
  if (usage.cached_input_tokens > usage.input_tokens || usage.reasoning_output_tokens > usage.output_tokens) return null;
  // Cached input is already inside input; reasoning is already inside output.
  usage.total_tokens = usage.input_tokens + usage.output_tokens;
  if (!Number.isSafeInteger(usage.total_tokens)) return null;
  return usage;
}

function localDay(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function averageSpeed(outputTokens, durationMs, firstTokenMs) {
  if (!Number.isSafeInteger(outputTokens) || outputTokens <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  const hasFirstToken = Number.isFinite(firstTokenMs) && firstTokenMs >= 0 && firstTokenMs < durationMs;
  const denominatorMs = hasFirstToken ? durationMs - firstTokenMs : durationMs;
  return {
    tokensPerSecond: outputTokens * 1000 / denominatorMs,
    denominatorMs,
    excludesFirstToken: hasFirstToken,
    kind: 'turn-average',
    includesToolTime: true,
  };
}

function contextStatus(percent, capacity) {
  if (!Number.isFinite(percent) || !Number.isFinite(capacity) || capacity <= 0) return { level: 'unknown', warningAt: null, criticalAt: null };
  const large = capacity >= 1000000;
  const warningAt = large ? 40 : 70;
  const criticalAt = large ? 60 : 85;
  return { level: percent >= criticalAt ? 'critical' : percent >= warningAt ? 'warning' : 'normal', warningAt, criticalAt };
}

function toolDurationMs(value) {
  if (!value || typeof value !== 'object') return null;
  const seconds = value.secs;
  const nanos = value.nanos;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || !Number.isSafeInteger(nanos) || nanos < 0 || nanos >= 1000000000) return null;
  const milliseconds = seconds * 1000 + nanos / 1000000;
  return Number.isFinite(milliseconds) && milliseconds <= 86400000 ? milliseconds : null;
}

class SessionAccumulator {
  constructor() {
    this.id = null;
    this.source = null;
    this.originator = null;
    this.parentId = null;
    this.model = null;
    this.totals = emptyUsage();
    this.contextUsed = null;
    this.contextWindow = null;
    this.lastUsage = null;
    this.lastUpdatedAt = null;
    this.hasUsage = false;
    this.activeTurn = null;
    this.lastTurn = null;
    this.turnCount = 0;
    this.daily = new Map();
    this.ownerId = null;
    this.accountingWarning = false;
    this.usageIncomplete = false;
    this.malformedLines = 0;
    this.toolIds = new Set();
    this.toolStats = emptyToolStats();
    this.contextExceeded = false;
  }

  processLine(line) {
    if (!line.trim()) return;
    let row;
    try { row = JSON.parse(line); } catch { this.malformedLines++; return; }
    this.processEvent(row);
  }

  processEvent(row) {
    if (!row || typeof row !== 'object' || !row.payload || typeof row.payload !== 'object') return;
    const p = row.payload;
    if (row.type === 'session_meta') {
      this.id = typeof p.id === 'string' ? p.id : this.id;
      this.source = p.source ?? null;
      this.originator = p.originator ?? null;
      this.parentId = p.source?.subagent?.thread_spawn?.parent_thread_id ?? p.parent_thread_id ?? null;
      return;
    }
    if (row.type === 'turn_context') {
      if (typeof p.model === 'string') this.model = p.model;
      return;
    }
    if (row.type !== 'event_msg') return;
    if (p.type === 'thread_settings_applied') {
      this.ownerId = typeof p.thread_id === 'string' ? p.thread_id : this.id;
      if (typeof p.thread_settings?.model === 'string') this.model = p.thread_settings.model;
      return;
    }
    // Forked histories can carry snapshots belonging to another logical thread.
    if (this.id && this.ownerId && this.ownerId !== this.id) return;
    if (p.type === 'item_completed' && p.item && Object.hasOwn(TOOL_LABELS, p.item.type)) {
      const item = p.item;
      if (typeof item.id === 'string' && item.id.length <= 256) {
        if (this.toolIds.has(item.id)) return;
        this.toolIds.add(item.id);
      }
      const failed = item.status === 'failed' || Number.isSafeInteger(item.exit_code) && item.exit_code !== 0 || Boolean(item.failure);
      const durationMs = toolDurationMs(item.duration);
      addTool(this.toolStats, item, failed, durationMs, row.timestamp);
      if (this.activeTurn) addTool(this.activeTurn.toolStats, item, failed, durationMs, row.timestamp);
      return;
    }
    if (p.type === 'task_started') {
      this.contextExceeded = false;
      if (!this.activeTurn || this.activeTurn.id !== p.turn_id) {
        this.activeTurn = {
          id: p.turn_id ?? null,
          baseline: { ...this.totals },
          baselineKnown: this.hasUsage,
          startedAt: row.timestamp,
          hasUsage: false,
          requests: 0,
          toolStats: emptyToolStats(),
        };
      }
      if (Number.isSafeInteger(p.model_context_window) && p.model_context_window > 0) this.contextWindow = p.model_context_window;
      return;
    }
    if (p.type === 'token_count' && p.info) {
      const total = usageOf(p.info.total_token_usage);
      if (!total) return;
      const last = usageOf(p.info.last_token_usage);
      if (!this.hasUsage) {
        // A resumed log may start with cumulative counters from earlier history.
        // Only the latest request belongs to this first observed increment.
        const canInfer = last && last.input_tokens <= total.input_tokens && last.output_tokens <= total.output_tokens;
        const baseline = { ...total };
        if (canInfer) {
          baseline.input_tokens -= last.input_tokens;
          baseline.output_tokens -= last.output_tokens;
          baseline.cached_input_tokens = Math.min(baseline.input_tokens, Math.max(0, total.cached_input_tokens - last.cached_input_tokens));
          baseline.reasoning_output_tokens = Math.min(baseline.output_tokens, Math.max(0, total.reasoning_output_tokens - last.reasoning_output_tokens));
          baseline.total_tokens = baseline.input_tokens + baseline.output_tokens;
        } else {
          this.usageIncomplete = true;
        }
        this.totals = baseline;
        if (this.activeTurn) {
          this.activeTurn.baseline = { ...baseline };
          this.activeTurn.baselineKnown = Boolean(canInfer);
          this.activeTurn.baselineInferred = Boolean(canInfer && baseline.total_tokens > 0);
        }
      }
      const decreases = TOKEN_FIELDS.some(key => total[key] < this.totals[key]);
      if (this.hasUsage && decreases) {
        // Never count a reset/replayed history as another whole session.
        this.accountingWarning = true;
        if (this.activeTurn) this.activeTurn.hasUsage = false;
      } else {
        const delta = emptyUsage();
        for (const key of TOKEN_FIELDS) delta[key] = total[key] - this.totals[key];
        delta.total_tokens = delta.input_tokens + delta.output_tokens;
        const day = localDay(row.timestamp);
        if (day && delta.total_tokens > 0) {
          const bucket = this.daily.get(day) ?? emptyUsage();
          for (const key of [...TOKEN_FIELDS, 'total_tokens']) bucket[key] += delta[key];
          this.daily.set(day, bucket);
        }
        if (this.activeTurn && delta.total_tokens > 0) {
          this.activeTurn.hasUsage = true;
          this.activeTurn.requests++;
        }
      }
      // Keep a monotonic high-water mark across replayed/compacted histories.
      for (const key of TOKEN_FIELDS) this.totals[key] = Math.max(this.totals[key], total[key]);
      this.totals.total_tokens = this.totals.input_tokens + this.totals.output_tokens;
      this.hasUsage = true;
      this.lastUsage = last;
      if (last && Number.isSafeInteger(p.info.last_token_usage.total_tokens) && p.info.last_token_usage.total_tokens >= 0) {
        this.contextUsed = p.info.last_token_usage.total_tokens;
      }
      if (Number.isSafeInteger(p.info.model_context_window) && p.info.model_context_window > 0) this.contextWindow = p.info.model_context_window;
      this.lastUpdatedAt = row.timestamp ?? null;
      return;
    }
    if (p.type === 'task_complete') {
      if (!this.activeTurn || (p.turn_id && this.activeTurn.id && p.turn_id !== this.activeTurn.id)) return;
      const turn = this.activeTurn;
      const tokens = emptyUsage();
      for (const key of TOKEN_FIELDS) tokens[key] = Math.max(0, this.totals[key] - turn.baseline[key]);
      tokens.total_tokens = tokens.input_tokens + tokens.output_tokens;
      const durationMs = Number.isFinite(p.duration_ms) && p.duration_ms > 0 ? p.duration_ms : null;
      const firstTokenMs = Number.isFinite(p.time_to_first_token_ms) && p.time_to_first_token_ms >= 0 ? p.time_to_first_token_ms : null;
      this.lastTurn = {
        tokens, durationMs, firstTokenMs,
        speed: turn.hasUsage && turn.baselineKnown && !this.accountingWarning ? averageSpeed(tokens.output_tokens, durationMs, firstTokenMs) : null,
        requests: turn.requests,
        toolUsage: toolSnapshot(turn.toolStats),
        completedAt: row.timestamp ?? null,
        status: p.error ? 'failed' : 'completed',
      };
      this.contextExceeded = /^(context_length_exceeded|context_window_exceeded|max_context_length_exceeded|prompt_too_long)$/i.test(p.error?.code ?? '');
      if (this.lastTurn.speed) this.lastTurn.speed.baselineInferred = Boolean(turn.baselineInferred);
      if (p.error) this.lastTurn.speed = null;
      this.turnCount++;
      this.activeTurn = null;
      return;
    }
    if (p.type === 'turn_aborted') {
      if (this.activeTurn) {
        this.contextExceeded = false;
        this.lastTurn = { tokens: null, speed: null, durationMs: null, firstTokenMs: null, requests: this.activeTurn.requests, toolUsage: toolSnapshot(this.activeTurn.toolStats), status: 'interrupted', completedAt: row.timestamp ?? null };
        this.activeTurn = null;
      }
    }
  }

  get isRootDesktop() {
    return !this.parentId && (this.source === 'vscode' || this.source === 'desktop' || /codex.*desktop|chatgpt|codex.*app/i.test(this.originator ?? ''));
  }

  snapshot() {
    const activeTokens = this.activeTurn ? emptyUsage() : null;
    if (activeTokens) {
      for (const key of TOKEN_FIELDS) activeTokens[key] = Math.max(0, this.totals[key] - this.activeTurn.baseline[key]);
      activeTokens.total_tokens = activeTokens.input_tokens + activeTokens.output_tokens;
    }
    const contextPercent = this.contextUsed !== null && this.contextWindow > 0 ? this.contextUsed * 100 / this.contextWindow : null;
    return {
      threadId: this.id,
      model: this.model,
      hasUsage: this.hasUsage,
      totals: { ...this.totals },
      context: {
        used: this.contextUsed,
        capacity: this.contextWindow,
        percent: contextPercent,
        ...contextStatus(contextPercent, this.contextWindow),
        exceeded: this.contextExceeded,
      },
      toolUsage: toolSnapshot(this.toolStats),
      turnToolUsage: this.activeTurn ? toolSnapshot(this.activeTurn.toolStats) : this.lastTurn?.toolUsage ?? null,
      turnRequests: this.activeTurn ? this.activeTurn.requests : this.lastTurn?.requests ?? null,
      cacheHitPercent: this.totals.input_tokens > 0 ? this.totals.cached_input_tokens * 100 / this.totals.input_tokens : null,
      active: Boolean(this.activeTurn),
      turnTokens: activeTokens ?? this.lastTurn?.tokens ?? null,
      lastTurn: this.lastTurn,
      turnCount: this.turnCount,
      updatedAt: this.lastUpdatedAt,
      accountingWarning: this.accountingWarning,
      usageIncomplete: this.usageIncomplete,
    };
  }
}

// Parses complete JSONL records only. A live writer may split both lines and UTF-8 characters.
class JsonlDecoder {
  constructor(onLine, maxLineBytes = 4 * 1024 * 1024) {
    this.onLine = onLine;
    this.maxLineBytes = maxLineBytes;
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.dropping = false;
    this.skippedLines = 0;
  }
  push(buffer) {
    const text = this.decoder.write(buffer);
    let start = 0;
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      const piece = text.slice(start, end);
      if (!this.dropping && Buffer.byteLength(this.pending) + Buffer.byteLength(piece) <= this.maxLineBytes) {
        this.onLine((this.pending + piece).replace(/\r$/, ''));
      } else {
        this.skippedLines++;
      }
      this.pending = '';
      this.dropping = false;
      start = end + 1;
    }
    if (!this.dropping) {
      this.pending += text.slice(start);
      if (Buffer.byteLength(this.pending) > this.maxLineBytes) { this.pending = ''; this.dropping = true; }
    }
  }
}

module.exports = { SessionAccumulator, JsonlDecoder, emptyUsage, usageOf, localDay, averageSpeed, contextStatus, toolDurationMs };
