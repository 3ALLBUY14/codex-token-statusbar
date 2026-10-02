'use strict';
const api = window.codexStatusbar;
const $ = id => document.getElementById(id);
let snapshot = null;
let detailsOpen = false;
let dragPointer = null;
let dragError = '';
let availableWidth = null;
let availableHeight = null;
let lastResize = '';
const metricNames = { speed: '平均输出速度', context: '上下文', session: '会话 Token', turn: '本轮 / 上轮 Token', today: '今日 Token', cache: '缓存命中率', tools: '工具调用' };
function renderToolGroups(target, groups, title) {
  target.replaceChildren();
  if (groups?.length) {
    const heading = document.createElement('span');
    heading.className = 'tool-section-title';
    heading.textContent = title;
    target.append(heading);
  }
  for (const group of groups ?? []) {
    const row = document.createElement('div');
    const label = document.createElement('span');
    const value = document.createElement('strong');
    label.textContent = group.label;
    value.textContent = `${number(group.total)} 次${group.failed ? ` · 失败 ${number(group.failed)}` : ''}${group.timed ? ` · ${time(group.durationMs)}` : ''}`;
    row.append(label, value);
    target.append(row);
  }
}

function compact(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000000000) return `${(value / 1000000000).toFixed(2)}B`;
  if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}
const number = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
const time = value => Number.isFinite(value) ? `${(value / 1000).toFixed(1)}s` : '—';
const modes = { following: '跟随当前聊天', recent: '最近活跃聊天', pinned: '已锁定聊天', ambiguous: '识别有歧义，请选择聊天', empty: '当前页面暂无本地聊天数据', unbound: '等待聊天数据' };

function fitMetrics() {
  const zoom = snapshot?.settings.scale ?? 1;
  const limit = Math.max(120, Math.floor((availableWidth ?? window.innerWidth) / zoom) - 16);
  $('shell').style.maxWidth = `${limit + 16}px`;
  $('bar').style.maxWidth = `${limit}px`;
  if (availableHeight) $('details').style.maxHeight = `${Math.max(160, Math.min(480, Math.floor(availableHeight / zoom) - $('bar').offsetHeight - 42))}px`;
  const metrics = $('metrics');
  const enabled = [...metrics.querySelectorAll('.metric:not([hidden])')];
  for (const node of enabled) node.classList.remove('overflowed');
  const more = $('more-count');
  more.hidden = true;
  const omitted = [];
  while ($('bar').scrollWidth > $('bar').clientWidth + 1 || metrics.scrollWidth > metrics.clientWidth + 1 || $('bar').offsetWidth > limit + 1) {
    const node = enabled.at(enabled.length - omitted.length - 1);
    if (!node) break;
    node.classList.add('overflowed');
    omitted.unshift(node);
    more.hidden = false;
    more.textContent = `+${omitted.length}`;
  }
  const list = $('overflow-list');
  list.replaceChildren();
  const metricValues = { speed: `${$('speed').textContent} t/s`, context: $('context').textContent, session: $('session').textContent, turn: $('turn').textContent, today: $('today').textContent, cache: $('cache').textContent, tools: `${$('tools').textContent}${$('tool-failed').textContent ? ` · ${$('tool-failed').textContent}` : ''}` };
  for (const node of omitted) {
    const row = document.createElement('div');
    const label = document.createElement('span');
    const value = document.createElement('strong');
    label.textContent = metricNames[node.dataset.metric];
    value.textContent = metricValues[node.dataset.metric];
    row.append(label, value);
    list.append(row);
  }
  list.hidden = omitted.length === 0;
  $('shell').style.width = detailsOpen ? `${Math.min(limit + 16, Math.max(520, $('bar').offsetWidth + 16))}px` : '';
  $('shell').style.alignItems = detailsOpen ? 'flex-end' : '';
}

function measure() {
  requestAnimationFrame(() => {
    fitMetrics();
    const zoom = snapshot?.settings.scale ?? 1;
    const width = Math.ceil((Math.max($('bar').offsetWidth, detailsOpen ? $('details').offsetWidth : 0) + 16) * zoom);
    const height = Math.ceil($('shell').getBoundingClientRect().height);
    const size = `${width}x${height}`;
    if (size !== lastResize) { lastResize = size; api.resize(width, height); }
  });
}
function detailVisibility(open) {
  detailsOpen = open;
  $('details').classList.toggle('open', open);
  document.querySelector('[data-action=details]').setAttribute('aria-expanded', String(open));
  measure();
}

function render(state) {
  snapshot = state;
  const s = state.session;
  const settings = state.settings;
  document.documentElement.classList.toggle('light', !state.dark);
  document.body.style.zoom = settings.scale;
  $('shell').classList.toggle('bottom', settings.placement !== 'top-right');
  $('bar').classList.toggle('zu-light', !state.dark);
  $('bar').classList.toggle('draggable', settings.allowDrag);
  $('shell').classList.toggle('hide-labels', settings.hideLabels);
  const shortModes = { following: '跟随', recent: '最近', pinned: '锁定', ambiguous: '待选', empty: '暂无', unbound: '等待' };
  $('route').textContent = shortModes[state.selection.mode];
  $('route').setAttribute('aria-label', modes[state.selection.mode]);
  for (const metric of ['speed', 'context', 'session', 'turn', 'today', 'cache', 'tools']) {
    document.querySelector(`[data-metric="${metric}"]`).hidden = !settings[`show${metric[0].toUpperCase()}${metric.slice(1)}`];
  }
  const speed = s?.lastTurn?.speed?.tokensPerSecond;
  $('speed').textContent = Number.isFinite(speed) ? `~${speed.toFixed(1)}` : '—';
  $('speed').className = `v ${speed >= 70 ? 'ok' : speed >= 40 ? 'warm' : Number.isFinite(speed) ? 'hot' : 'dim'}`;
  const pct = s?.context.percent;
  const contextClass = s?.context.exceeded || s?.context.level === 'critical' ? 'hot' : s?.context.level === 'warning' ? 'warm' : Number.isFinite(pct) ? 'ok' : 'dim';
  $('context').textContent = Number.isFinite(pct) ? `${pct.toFixed(1)}%` : '—';
  $('context').className = `pct ${contextClass}`;
  $('context-bar').className = `cbar ${contextClass}`;
  $('context-fill').style.width = `${Math.min(100, Math.max(0, pct ?? 0))}%`;
  $('session').textContent = s?.hasUsage ? compact(s.totals.total_tokens) : '—';
  $('turn').textContent = compact(s?.turnTokens?.total_tokens);
  $('turn-label').textContent = s?.active ? '本轮' : '上轮';
  $('today').textContent = `${state.today.partial ? '≈' : ''}${compact(state.today.usage.total_tokens)}`;
  $('cache').textContent = Number.isFinite(s?.cacheHitPercent) ? `${s.cacheHitPercent.toFixed(0)}%` : '—';
  const tools = s?.toolUsage;
  $('tools').textContent = tools ? number(tools.total) : '—';
  $('tool-failed').textContent = tools?.failed ? `!${number(tools.failed)}` : '';
  $('tools-detail').textContent = tools ? `${number(tools.total)} 次 · 失败 ${number(tools.failed)} 次 · 有耗时记录 ${number(tools.timed)} 次 / ${time(tools.durationMs)}` : '—';
  renderToolGroups($('tool-breakdown'), tools?.byType, '会话工具分类');
  const turnTools = s?.turnToolUsage;
  $('turn-requests-label').textContent = s?.active ? '本轮模型请求' : '上轮模型请求';
  $('turn-tools-label').textContent = s?.active ? '本轮工具调用' : '上轮工具调用';
  $('turn-requests-detail').textContent = Number.isFinite(s?.turnRequests) ? `${number(s.turnRequests)} 次` : '—';
  $('turn-tools-detail').textContent = turnTools ? `${number(turnTools.total)} 次 · 失败 ${number(turnTools.failed)} 次 · 有耗时记录 ${number(turnTools.timed)} 次 / ${time(turnTools.durationMs)}` : '—';
  renderToolGroups($('turn-tool-breakdown'), turnTools?.byType, s?.active ? '本轮工具分类' : '上轮工具分类');
  $('activity').className = `activity ${s?.active ? 'busy' : s?.hasUsage ? 'done' : ''}`;
  $('activity').setAttribute('aria-label', s?.active ? '当前聊天正在运行；均速保留上一轮结果' : s?.hasUsage ? '当前聊天空闲' : '等待 Token 记录');
  $('binding').textContent = modes[state.selection.mode];
  $('chat-title').textContent = state.selection.title ?? '';
  $('chat-title').hidden = !state.selection.title;
  $('model').textContent = s?.model ?? '模型待记录';
  $('thread').textContent = state.selection.threadId?.slice(0, 8) ?? '—';
  for (const [id, field] of [['input-detail','input_tokens'], ['cached-detail','cached_input_tokens'], ['output-detail','output_tokens'], ['reasoning-detail','reasoning_output_tokens'], ['total-detail','total_tokens']]) {
    $(id).textContent = s?.hasUsage ? number(s.totals[field]) : '—';
  }
  $('context-detail').textContent = `${number(s?.context.used)} / ${number(s?.context.capacity)}`;
  $('context-origin').textContent = s?.context.overridden ? '手动窗口容量' : '最新调用';
  $('time-detail').textContent = `${time(s?.lastTurn?.durationMs)} / ${time(s?.lastTurn?.firstTokenMs)}`;
  $('speed-detail').textContent = Number.isFinite(speed) ? `≈ ${speed.toFixed(1)} tokens/s` : '—';
  $('speed-note').textContent = Number.isFinite(speed)
    ? `平均速度＝上一轮输出 Token ÷ ${s.lastTurn.speed.excludesFirstToken ? '（轮次耗时－首 Token 延迟）' : '轮次耗时'}。包含推理输出、工具执行和多次模型调用，不能代表纯生成速度。`
    : '完成一轮并记录输出 Token 与耗时后显示平均速度。它包含工具执行和多次模型调用，不能代表纯生成速度。';
  const notes = [];
  if (dragError) notes.push(dragError);
  if (state.selection.mode === 'recent') notes.push('正在重新识别当前聊天，暂显示最近活跃聊天。');
  if (state.selection.mode === 'ambiguous') notes.push('多个窗口或同名聊天无法唯一识别，请在设置中选择并锁定聊天。');
  if (state.selection.mode === 'empty') notes.push('当前页面没有可绑定的本地聊天，等待进入聊天或产生首次本地记录。');
  if (s?.accountingWarning) notes.push('日志存在回放或计数回退，累计保留已知上界，速度暂停显示。');
  if (s?.usageIncomplete) notes.push('日志缺少初始用量基线，今日统计可能不完整。');
  if (s?.lastTurn?.speed?.baselineInferred) notes.push('此轮起始用量由首条请求记录推算，均速为估算值。');
  if (s?.context.exceeded) notes.push('上一轮日志报告上下文长度超限；请缩短输入或开启新聊天。');
  else if (s?.context.level === 'critical') notes.push(`上下文占用较高（${s.context.criticalAt}% 起为红色）；可考虑开启新聊天。`);
  else if (s?.context.level === 'warning') notes.push(`上下文接近预警线（${s.context.warningAt}% 起为黄色）。`);
  if (state.health.indexing) notes.push('正在读取历史日志，当前显示已读取的部分。');
  if (state.health.readErrors) notes.push('部分日志暂不可读，自动重试中。');
  if (state.health.truncated) notes.push('历史文件超过本版读取上限，今日统计可能不完整。');
  $('state-note').textContent = notes.join(' ');
  const updated = s?.updatedAt ? new Date(s.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : null;
  $('updated').textContent = updated ? `Token 更新于 ${updated} · 只读本地日志` : '只读本地日志 · 等待首次模型响应';
  measure();
}

document.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'details') detailVisibility(!detailsOpen);
  if (action === 'settings') api.settings();
  if (action === 'refresh') api.refresh();
});
$('bar').addEventListener('mouseenter', () => $('bar').classList.add('pointer-near'));
$('bar').addEventListener('mouseleave', () => $('bar').classList.remove('pointer-near'));
$('bar').addEventListener('pointerdown', event => {
  if (!snapshot?.settings.allowDrag || event.button !== 0 || event.target.closest('button')) return;
  event.preventDefault();
  dragError = '';
  dragPointer = event.pointerId;
  $('bar').setPointerCapture(dragPointer);
  $('bar').classList.add('dragging');
  api.drag('start', { x: event.screenX, y: event.screenY });
});
$('bar').addEventListener('pointermove', event => {
  if (event.pointerId === dragPointer) api.drag('move');
});
function finishDrag(event, action) {
  if (event.pointerId !== dragPointer) return;
  const pointer = dragPointer;
  dragPointer = null;
  $('bar').classList.remove('dragging');
  if ($('bar').hasPointerCapture(pointer)) $('bar').releasePointerCapture(pointer);
  api.drag(action);
}
$('bar').addEventListener('pointerup', event => finishDrag(event, 'end'));
$('bar').addEventListener('pointercancel', event => finishDrag(event, 'cancel'));
$('bar').addEventListener('lostpointercapture', event => finishDrag(event, 'cancel'));
new ResizeObserver(measure).observe($('shell'));
api.onSnapshot(render);
api.onCompact(layout => { availableWidth = layout.availableWidth; availableHeight = layout.availableHeight; $('shell').classList.toggle('compact', layout.compact); measure(); });
api.onCollapse(() => $('bar').classList.remove('pointer-near'));
api.onDragError(message => { dragError = message; if (snapshot) render(snapshot); });
api.ready();
