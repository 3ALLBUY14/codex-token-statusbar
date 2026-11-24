'use strict';
const api = window.codexStatusbar;
const $ = id => document.getElementById(id);
const titleWords = new Intl.Segmenter(undefined, { granularity: 'word' });
const snapshotGuard = new SnapshotGuard();
let snapshot = null;
let detailsOpen = false;
let dragPointer = null;
let dragError = '';
let availableWidth = null;
let availableHeight = null;
let titlebarHeight = null;
let lastResize = '';
let opacityPreview = null;
let detailContext = null;
let detailPage = 'overview', selectedModel = null, modelPickerKey = '';
const detailPages = ['overview', 'activity', 'models', 'requests'];
let activityPeriod = 365;
function chooseDetailPage(page) {
  detailPage = page;
  for (const name of detailPages) {
    const selected = page === name;
    $(`tab-${name}`).setAttribute('aria-selected', String(selected)); $(`tab-${name}`).tabIndex = selected ? 0 : -1;
    $(`${name}-panel`).hidden = !selected;
  }
  $('details').scrollTop = 0;
  renderActivity();
  window.requestPanel.update(snapshot, detailsOpen && page === 'requests');
  measure();
}
function renderActivity() {
  if (!snapshot || !detailsOpen || detailPage !== 'activity') return;
  const all = $('activity-scope').value === 'all';
  const activity = all ? snapshot.allActivity : snapshot.session?.accounting?.activity;
  const scope = all ? '全部本地聊天' : '当前聊天';
  const scopeKey = all ? 'all' : (snapshot.selection.threadId ?? 'empty');
  const partial = Boolean(activity?.partial || snapshot.health.indexing || snapshot.health.truncated || snapshot.health.readErrors);
  renderActivityGrid($('activity-chart'), { days: activity?.days ?? [], partial }, scopeKey, scope, activityPeriod);
}
$('activity-scope').addEventListener('change', () => { renderActivity(); measure(); });
for (const button of $('activity-period').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    activityPeriod = Number(button.dataset.days);
    for (const choice of $('activity-period').children) choice.setAttribute('aria-pressed', String(choice === button));
    renderActivity();
    measure();
  });
}
function tabKeys(event, buttons) {
  let index = buttons.indexOf(event.currentTarget);
  if (event.key === 'ArrowRight') index = (index + 1) % buttons.length;
  else if (event.key === 'ArrowLeft') index = (index + buttons.length - 1) % buttons.length;
  else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = buttons.length - 1;
  else return;
  event.preventDefault(); buttons[index].click(); buttons[index].focus({ preventScroll: true });
}
for (const name of detailPages) {
  $(`tab-${name}`).addEventListener('click', () => chooseDetailPage(name));
  $(`tab-${name}`).addEventListener('keydown', event => tabKeys(event, detailPages.map(page => $(`tab-${page}`))));
}
function renderModelPage(session) {
  const rows = [...(session?.accounting?.byModel ?? [])].sort((a, b) => b.total_tokens - a.total_tokens);
  if (!rows.some(row => row.model === selectedModel)) selectedModel = rows.find(row => row.model === session?.model)?.model ?? rows[0]?.model ?? null;
  const visible = rows.slice(0, 30);
  for (const row of rows) if ((row.model === selectedModel || /历史未归属/.test(row.model)) && !visible.includes(row)) visible.push(row);
  const key = JSON.stringify(visible.map(row => row.model));
  if (key !== modelPickerKey) {
    const focused = $('model-picker').contains(document.activeElement) ? document.activeElement.dataset.model : null;
    modelPickerKey = key; $('model-picker').replaceChildren();
    for (const row of visible) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.model = row.model;
      button.textContent = row.model; button.title = row.model; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'model-page-numbers');
      button.addEventListener('click', () => { selectedModel = row.model; renderModelPage(snapshot?.session); measure(); });
      button.addEventListener('keydown', event => tabKeys(event, [...$('model-picker').children])); $('model-picker').append(button);
    }
    if (focused) [...$('model-picker').children].find(button => button.dataset.model === focused)?.focus({ preventScroll: true });
  }
  for (const button of $('model-picker').children) { const selected = button.dataset.model === selectedModel; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
  const row = rows.find(item => item.model === selectedModel);
  $('model-page-empty').hidden = Boolean(row); $('model-page-numbers').hidden = !row;
  $('model-tab-label').textContent = rows.length ? `模型 ${rows.filter(item => !/未归属|未记录/.test(item.model)).length}` : '模型';
  $('model-page-meta').textContent = row ? `${row.model === session.model ? '当前模型' : /未归属|未记录/.test(row.model) ? '归属待确认' : '历史模型'} · 占会话 ${session.totals.total_tokens ? (row.total_tokens * 100 / session.totals.total_tokens).toFixed(1) : '0.0'}%${rows.length > visible.length ? ' · 按用量列前 30 个' : ''}` : '';
  for (const [id, field] of [['model-total', 'total_tokens'], ['model-input', 'input_tokens'], ['model-cached', 'cached_input_tokens'], ['model-output', 'output_tokens'], ['model-reasoning', 'reasoning_output_tokens'], ['model-requests', 'requests']]) $(id).textContent = row ? Number.isFinite(row[field]) ? number(row[field]) : '未记录' : '—';
}
function applyOpacity() {
  const value = opacityPreview ?? snapshot?.settings.opacity ?? 1;
  $('bar').style.setProperty('--bar-opacity', String(value));
  $('bar').style.setProperty('--bar-hover-opacity', String(Math.min(value, 0.45)));
}
const metricNames = new Map(MetricOptions.metrics.map(({ id, label }) => [id, label]));
const metricNodes = new Map([...$('metrics').children].map(node => [node.dataset.metric, node]));
let lastMetricOrder = '';
function renderToolGroups(target, groups, title) {
  target.replaceChildren();
  if (groups?.length) {
    const heading = document.createElement('span');
    heading.className = 'tool-section-title';
    heading.textContent = title;
    target.append(heading);
  }
  const total = (groups ?? []).reduce((sum, group) => sum + group.total, 0);
  for (const group of [...(groups ?? [])].sort((left, right) => right.total - left.total)) {
    const row = document.createElement('div');
    row.dataset.toolType = group.type;
    const label = document.createElement('span');
    label.className = 'semantic-key';
    const value = document.createElement('strong');
    label.textContent = group.label;
    value.textContent = `${number(group.total)} 次${group.failed ? ` · 失败 ${number(group.failed)}` : ''}${group.timed ? ` · ${time(group.durationMs)}` : ''}`;
    const track = document.createElement('span'), fill = document.createElement('i');
    track.className = 'monitor-progress';
    track.setAttribute('aria-hidden', 'true');
    fill.style.width = `${total ? group.total * 100 / total : 0}%`;
    track.append(fill);
    row.append(label, value, track);
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
const contextPartLabels = {
  uncached: ['未缓存输入', 'blue'], cached: ['缓存输入', 'teal'], input: ['输入', 'blue'],
  output: ['非推理输出', 'amber'], reasoning: ['推理输出', 'violet'], combinedOutput: ['输出', 'amber'],
};
let contextPartsKey, quotaKey;
function renderContextParts(context) {
  const parts = context?.used > 0 ? context.parts : null;
  const key = JSON.stringify(parts);
  if (key === contextPartsKey) return;
  contextPartsKey = key;
  const fill = $('context-meter-fill'), legend = $('context-parts');
  fill.replaceChildren();
  legend.replaceChildren();
  legend.hidden = !parts;
  fill.classList.toggle('is-segmented', Boolean(parts));
  if (!parts) return;
  for (const [id, count] of Object.entries(parts)) {
    const [label, tone] = contextPartLabels[id];
    const row = document.createElement('div'), name = document.createElement('dt'), value = document.createElement('dd');
    name.className = 'semantic-key';
    name.dataset.tone = tone;
    name.textContent = label;
    value.textContent = number(count);
    row.append(name, value);
    legend.append(row);
    if (count > 0) {
      const segment = document.createElement('span');
      segment.dataset.tone = tone;
      segment.style.width = `${count * 100 / context.used}%`;
      fill.append(segment);
    }
  }
}
const quotaPlans = { free: 'ChatGPT Free', go: 'ChatGPT Go', plus: 'ChatGPT Plus', pro: 'ChatGPT Pro', business: 'ChatGPT Business', team: 'ChatGPT Team', enterprise: 'ChatGPT Enterprise', edu: 'ChatGPT Edu' };
const quotaDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const quotaPercent = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
function quotaWindowLabel(minutes) {
  if (minutes === 10080) return '周额度';
  if (!minutes) return '额度窗口';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天额度`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`;
  return `${minutes} 分钟额度`;
}
function renderQuota(quota) {
  const now = Date.now(), samples = quota?.windows ?? [];
  const official = quota?.source === 'official';
  const expected = [300, 10080];
  const windows = expected.map(minutes => samples.find(window => window.minutes === minutes) ?? { minutes });
  windows.push(...samples.filter(window => !expected.includes(window.minutes)));
  const expired = windows.map(window => window.reset != null && window.reset <= now);
  const key = JSON.stringify([quota, expired]);
  if (key === quotaKey) return;
  quotaKey = key;
  $('quota-plan').textContent = quota && Object.hasOwn(quotaPlans, quota.plan) ? quotaPlans[quota.plan] : quota?.name ?? '';
  const list = $('quota-windows');
  list.replaceChildren();
  for (const [index, window] of windows.entries()) {
    if (quota?.plan === 'pro' && window.minutes === 300) continue;
    const row = document.createElement('div'), summary = document.createElement('div');
    const label = document.createElement('b'), remaining = document.createElement('strong');
    const progress = document.createElement('div'), fill = document.createElement('i'), detail = document.createElement('small');
    row.className = 'quota-row';
    row.dataset.tone = expired[index] ? 'muted' : window.percent >= 95 ? 'rose' : window.percent >= 80 ? 'amber' : 'blue';
    summary.className = 'quota-row-heading';
    label.textContent = quotaWindowLabel(window.minutes);
    if (window.percent === undefined) {
      const missing = document.createElement('small');
      missing.textContent = official ? '官方未返回' : quota?.status === 'refreshing' ? '正在查询' : '暂无记录';
      summary.append(label, missing);
      row.append(summary);
      list.append(row);
      continue;
    }
    remaining.textContent = `${expired[index] ? '上次剩余' : '剩余'} ${quotaPercent.format(100 - window.percent)}%`;
    summary.append(label, remaining);
    progress.className = 'monitor-progress quota-meter';
    progress.setAttribute('role', 'meter');
    progress.setAttribute('aria-label', `${label.textContent}已用`);
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    progress.setAttribute('aria-valuenow', String(window.percent));
    fill.style.width = `${window.percent}%`;
    progress.append(fill);
    const reset = expired[index] ? '已到重置时间，等待新记录' : window.reset !== null ? `${quotaDate.format(window.reset)} 重置` : '未记录重置时间';
    detail.textContent = `已用 ${quotaPercent.format(window.percent)}% · ${reset}`;
    row.append(summary, progress, detail);
    list.append(row);
  }
  const source = official ? '官方接口' : quota?.source === 'sample' ? '示例数据' : '本机记录';
  const recorded = Number.isFinite(quota?.recordedAt) ? `${source} · ${quotaDate.format(quota.recordedAt)}` : '';
  const status = quota?.status === 'refreshing' ? '正在刷新' : quota?.status === 'unavailable' ? '官方额度暂不可用' : '';
  $('quota-record').textContent = [recorded, status].filter(Boolean).join(' · ') || '暂无额度数据';
}
function overviewTokens(id, value) {
  const target = $(id), exact = number(value);
  target.textContent = value >= 10000000 ? compact(value) : exact;
  target.title = Number.isFinite(value) ? `${exact} Token` : '';
  if (target.title) target.setAttribute('aria-label', target.title);
  else target.removeAttribute('aria-label');
}
function overviewTools(id, usage) {
  const target = $(id), duration = usage?.durationMs;
  if (!usage) { target.textContent = '—'; target.title = ''; return; }
  const minutes = Number.isFinite(duration) ? Math.floor(duration / 60000) : 0;
  let elapsed = time(duration);
  if (minutes >= 60) elapsed = `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
  else if (minutes) elapsed = `${minutes}分${String(Math.floor(duration / 1000) % 60).padStart(2, '0')}秒`;
  target.textContent = `${number(usage.total)} 次`;
  if (usage.failed) {
    const failure = document.createElement('span');
    failure.className = 'summary-failure';
    failure.textContent = `${number(usage.failed)} 失败`;
    target.append(failure);
  }
  if (usage.timed) {
    const timing = document.createElement('span'), icon = document.createElement('i');
    timing.className = 'overview-tool-timing';
    icon.className = 'ui-icon';
    icon.dataset.icon = 'clock';
    icon.setAttribute('aria-hidden', 'true');
    timing.append(icon, elapsed);
    target.append(timing);
  }
  target.title = `失败 ${number(usage.failed)} 次；${number(usage.timed)} 次有耗时记录，共 ${time(duration)}`;
}
let noticeSignature = '';
function showNotices(notices) {
  const signature = JSON.stringify(notices);
  if (signature === noticeSignature) return;
  noticeSignature = signature;
  const button = $('state-note'), details = $('state-details'), list = details.querySelector('ul');
  button.replaceChildren();
  list.replaceChildren();
  button.hidden = details.hidden = !notices.length;
  for (const [label, description] of notices) {
    const chip = document.createElement('span'), item = document.createElement('li');
    chip.className = 'semantic-key';
    chip.textContent = label;
    chip.title = description;
    item.textContent = description;
    button.append(chip);
    list.append(item);
  }
}
$('state-note').addEventListener('click', () => {
  const details = $('detail-explanation');
  details.open = true;
  $('state-details').scrollIntoView({ block: 'nearest' });
});
const modes = { following: '跟随当前聊天', recent: '最近活跃聊天', pinned: '已锁定聊天', ambiguous: '识别有歧义，请选择聊天', empty: '当前页面暂无本地聊天数据', unbound: '等待聊天数据' };

function fitMetrics() {
  const titlebar = snapshot?.settings.dockToComposer && snapshot.settings.dockTarget === 'titlebar';
  $('shell').classList.toggle('titlebar', Boolean(titlebar));
  const zoom = titlebar ? Math.min(snapshot.settings.scale, Math.max(0.6, ((titlebarHeight ?? 32) - 4) / ($('bar').offsetHeight + 4))) : snapshot?.settings.scale ?? 1;
  document.body.style.zoom = zoom;
  const limit = Math.max(120, Math.floor((availableWidth ?? window.innerWidth) / zoom) - 16);
  $('shell').style.maxWidth = `${limit + 16}px`;
  $('bar').style.maxWidth = `${limit}px`;
  if (availableHeight) $('details').style.maxHeight = `${Math.max(32, Math.min(480, Math.floor(availableHeight / zoom) - $('bar').offsetHeight - 42))}px`;
  const metrics = $('metrics');
  const enabled = [...metrics.querySelectorAll('.metric:not([hidden])')];
  for (const node of enabled) node.classList.remove('overflowed');
  const more = $('more-count');
  more.hidden = true;
  const omitted = [];
  while ($('bar').scrollWidth > $('bar').clientWidth + 1 || metrics.scrollWidth > metrics.clientWidth + 1 || $('bar').offsetWidth > limit + 1) {
    const node = enabled[enabled.length - omitted.length - 1];
    if (!node) break;
    node.classList.add('overflowed');
    omitted.unshift(node);
    more.hidden = false;
    more.textContent = `+${omitted.length}`;
  }
  more.setAttribute('aria-label', `${omitted.length} 个指标已收起，请点击 C 查看明细`);
  document.querySelector('[data-action=details]').setAttribute('aria-label', detailsOpen ? '收起用量明细' : `展开用量明细${omitted.length ? `，含 ${omitted.length} 个收起指标` : ''}`);
  const list = $('overflow-list');
  list.replaceChildren();
  const metricValues = { today: $('today').textContent, cache: $('cache').textContent };
  for (const node of omitted) {
    // Other omitted metrics already appear in the main detail summary.
    if (!Object.hasOwn(metricValues, node.dataset.metric)) continue;
    const row = document.createElement('div');
    const label = document.createElement('span');
    const value = document.createElement('strong');
    label.textContent = metricNames.get(node.dataset.metric);
    value.textContent = metricValues[node.dataset.metric];
    row.append(label, value);
    list.append(row);
  }
  list.hidden = list.children.length === 0;
  $('shell').style.width = detailsOpen ? `${Math.min(limit + 16, Math.max(520, $('bar').offsetWidth + 16))}px` : '';
  const alignment = snapshot?.settings.dockToComposer ? snapshot.settings.composerAlignment : 'right';
  $('shell').style.alignItems = detailsOpen ? { left: 'flex-start', center: 'center', right: 'flex-end' }[alignment] ?? 'center' : '';
}

function measure() {
  const update = () => {
    fitMetrics();
    const zoom = Number(document.body.style.zoom) || 1;
    const width = Math.ceil((Math.max($('bar').offsetWidth, detailsOpen ? $('details').offsetWidth : 0) + 16) * zoom);
    const height = Math.ceil($('shell').getBoundingClientRect().height);
    const size = `${width}x${height}`;
    if (size !== lastResize) { lastResize = size; api.resize(width, height, Math.ceil(($('bar').offsetHeight + ($('shell').classList.contains('titlebar') ? 4 : 16)) * zoom)); }
  };
  // Hidden docked windows must measure before they can become visible again.
  if (document.hidden) update(); else requestAnimationFrame(update);
}
function detailVisibility(open) {
  detailsOpen = open;
  $('details').classList.toggle('open', open);
  document.querySelector('[data-action=details]').setAttribute('aria-expanded', String(open));
  if (open) renderQuota(snapshot?.quota);
  renderActivity();
  window.requestPanel.update(snapshot, open && detailPage === 'requests');
  measure();
}

function render(state) {
  if (!snapshotGuard.accept(state)) return;
  if (detailContext !== state.selection.threadId) {
    for (const item of document.querySelectorAll('.detail-extra')) item.open = false;
    detailContext = state.selection.threadId;
    selectedModel = null; modelPickerKey = ''; chooseDetailPage('overview');
  }
  snapshot = state;
  document.documentElement.classList.toggle('light', !state.dark);
  renderModelPage(state.session);
  renderActivity();
  window.requestPanel.update(state, detailsOpen && detailPage === 'requests');
  renderUsageDetails($('usage-details'), state.session);
  const s = state.session;
  const settings = state.settings;
  const gear = $('gear'), update = state.update;
  gear.classList.toggle('has-update', Boolean(update?.newer));
  const gearLabel = update?.newer ? `发现新版 ${update.tag}，查看更新` : '设置';
  gear.setAttribute('aria-label', gearLabel);
  gear.title = gearLabel;
  applyOpacity();
  document.body.style.zoom = settings.scale;
  $('shell').classList.toggle('bottom', settings.placement !== 'top-right');
  $('bar').classList.toggle('zu-light', !state.dark);
  $('bar').classList.toggle('draggable', settings.allowDrag && !settings.dockToComposer);
  $('shell').classList.toggle('hide-labels', settings.hideLabels);
  const shortModes = { following: '跟随', recent: '最近', pinned: '锁定', ambiguous: '待选', empty: '暂无', unbound: '等待' };
  $('route').textContent = shortModes[state.selection.mode];
  $('route').setAttribute('aria-label', modes[state.selection.mode]);
  const order = MetricOptions.orderedIds(settings.metricOrder);
  if (lastMetricOrder !== order.join(',')) {
    for (const id of order) $('metrics').append(metricNodes.get(id));
    lastMetricOrder = order.join(',');
  }
  for (const metric of MetricOptions.metrics) metricNodes.get(metric.id).hidden = !settings[metric.setting];
  const speed = s?.lastTurn?.speed?.tokensPerSecond;
  $('speed').textContent = Number.isFinite(speed) ? `~${speed.toFixed(1)}` : '—';
  $('speed').className = `v ${speed >= 70 ? 'ok' : speed >= 40 ? 'warm' : Number.isFinite(speed) ? 'hot' : 'dim'}`;
  $('ttft').textContent = time(s?.lastTurn?.firstTokenMs);
  const pct = s?.context.percent;
  const contextClass = s?.context.exceeded || s?.context.level === 'critical' ? 'hot' : s?.context.level === 'warning' ? 'warm' : Number.isFinite(pct) ? 'ok' : 'dim';
  $('context').textContent = Number.isFinite(pct) ? `${pct.toFixed(1)}%` : '—';
  $('context').className = `pct ${contextClass}`;
  const meter = $('context-meter'), progress = Math.min(100, Math.max(0, pct ?? 0));
  const ring = $('context-bar');
  ring.className = `context-ring ${contextClass}`;
  ring.style.setProperty('--context-fill', `${progress}%`);
  meter.className = `monitor-progress ${contextClass}`;
  $('context-meter-fill').style.width = `${progress}%`;
  renderContextParts(s?.context);
  renderQuota(state.quota);
  const warning = s?.context.warningAt, critical = s?.context.criticalAt;
  const showScale = Number.isFinite(warning) && Number.isFinite(critical);
  $('context-legend').hidden = !showScale;
  meter.classList.toggle('has-scale', showScale);
  if (showScale) {
    meter.style.setProperty('--warning-at', `${warning}%`);
    meter.style.setProperty('--critical-at', `${critical}%`);
    $('context-warning-label').textContent = `预警 ${warning}%`;
    $('context-critical-label').textContent = `高占用 ${critical}%`;
  }
  if (Number.isFinite(pct)) meter.setAttribute('aria-valuenow', String(progress));
  else meter.removeAttribute('aria-valuenow');
  meter.setAttribute('aria-valuetext', Number.isFinite(pct) ? $('context').textContent : '未记录');
  $('context-detail-percent').textContent = $('context').textContent;
  $('context-detail-percent').className = contextClass;
  const contextTone = $('context-state');
  contextTone.textContent = s?.context.exceeded ? '超出容量' : contextClass === 'hot' ? '占用较高' : contextClass === 'warm' ? '接近预警' : Number.isFinite(pct) ? '正常' : '';
  contextTone.className = contextClass;
  $('session').textContent = s?.hasUsage ? compact(s.totals.total_tokens) : '—';
  $('turn').textContent = compact(s?.turnTokens?.total_tokens);
  $('turn-label').textContent = s?.active ? '本轮' : '上轮';
  $('today').textContent = `${state.today.partial ? '≈' : ''}${compact(state.today.usage.total_tokens)}`;
  $('cache').textContent = Number.isFinite(s?.cacheHitPercent) ? `${s.cacheHitPercent.toFixed(0)}%` : '—';
  const tools = s?.toolUsage;
  $('tools').textContent = tools ? number(tools.total) : '—';
  $('tool-failed').textContent = tools?.failed ? `!${number(tools.failed)}` : '';
  overviewTools('tools-detail', tools);
  $('tools-fold-summary').textContent = tools ? `${number(tools.total)} 次${tools.failed ? ` · ${number(tools.failed)} 次失败` : ''}` : '';
  renderToolGroups($('tool-breakdown'), tools?.byType, '会话工具分类');
  const turnTools = s?.turnToolUsage;
  $('detail-tools').hidden = !(tools?.byType?.length || turnTools?.byType?.length);
  $('turn-requests-label').textContent = s?.active ? '本轮模型请求' : '上轮模型请求';
  $('turn-tools-label').textContent = s?.active ? '本轮工具调用' : '上轮工具调用';
  $('turn-requests-detail').textContent = Number.isFinite(s?.turnRequests) ? `${number(s.turnRequests)} 次` : '—';
  overviewTools('turn-tools-detail', turnTools);
  renderToolGroups($('turn-tool-breakdown'), turnTools?.byType, s?.active ? '本轮工具分类' : '上轮工具分类');
  $('activity').className = `activity ${s?.active ? 'busy' : s?.hasUsage ? 'done' : ''}`;
  $('activity').setAttribute('aria-label', s?.active ? '当前聊天正在运行；均速保留上一轮结果' : s?.hasUsage ? '当前聊天空闲' : '等待 Token 记录');
  const runState = $('chat-run-state');
  runState.textContent = s?.active ? '运行中' : s?.hasUsage ? '空闲' : '等待记录';
  runState.classList.toggle('running', Boolean(s?.active));
  $('binding').textContent = modes[state.selection.mode];
  const title = state.selection.title || '当前聊天';
  $('chat-title').textContent = Array.from(titleWords.segment(title), ({ segment }) =>
    segment.replace(/^\p{Ll}/u, letter => letter.toUpperCase())).join('');
  $('chat-title').title = $('chat-title').textContent;
  $('model').textContent = s?.model ?? '模型待记录';
  $('thread').textContent = state.selection.threadId?.slice(0, 8) ?? '—';
  for (const [id, field] of [['input-detail','input_tokens'], ['cached-detail','cached_input_tokens'], ['output-detail','output_tokens'], ['reasoning-detail','reasoning_output_tokens']]) {
    $(id).textContent = s?.hasUsage ? number(s.totals[field]) : '—';
  }
  overviewTokens('total-detail', s?.hasUsage ? s.totals.total_tokens : null);
  $('token-fold-summary').textContent = s?.hasUsage ? `${compact(s.totals.total_tokens)} Token` : '';
  const modelCount = (s?.accounting?.byModel ?? []).filter(row => !/未归属|未记录|旧格式/.test(row.model)).length;
  const relatedCount = s?.accounting?.relatedThreads ?? 0;
  $('usage-fold-summary').textContent = s?.accounting ? [modelCount && `${modelCount} 个模型`, relatedCount && `${relatedCount} 个子任务`].filter(Boolean).join(' · ') || '查看来源' : '';
  const input = s?.totals.input_tokens, cached = s?.totals.cached_input_tokens, output = s?.totals.output_tokens;
  const composition = $('token-compose');
  composition.hidden = !s?.hasUsage || ![input, cached, output].every(Number.isFinite) || cached < 0 || cached > input || output < 0 || input + output === 0;
  if (!composition.hidden) {
    const uncached = input - cached;
    $('new-input-detail').textContent = compact(uncached);
    [...composition.querySelector('.token-stack').children].forEach((part, index) => {
      part.style.width = `${[uncached, cached, output][index] * 100 / (input + output)}%`;
    });
  }
  $('context-detail').textContent = `${number(s?.context.used)} / ${number(s?.context.capacity)}`;
  $('turn-total-label').textContent = s?.active ? '本轮 Token' : '上轮 Token';
  overviewTokens('turn-total-detail', s?.turnTokens?.total_tokens);
  $('context-origin').textContent = s?.context.overridden ? '手动窗口容量' : '最新调用';
  $('time-detail').textContent = `${time(s?.lastTurn?.durationMs)} / ${time(s?.lastTurn?.firstTokenMs)}`;
  $('ttft-detail').textContent = $('ttft').textContent;
  $('speed-detail').textContent = Number.isFinite(speed) ? `≈ ${speed.toFixed(1)} t/s` : '—';
  $('speed-note').textContent = Number.isFinite(speed)
    ? `平均速度＝上一轮输出 Token ÷ ${s.lastTurn.speed.excludesFirstToken ? '（轮次耗时－首 Token 延迟）' : '轮次耗时'}。包含推理输出、工具执行和多次模型调用，不能代表纯生成速度。`
    : '完成一轮并记录输出 Token 与耗时后显示平均速度。它包含工具执行和多次模型调用，不能代表纯生成速度。';
  const notes = [];
  if (s?.accounting?.unassignedTokens > 0) notes.push(['历史未归属', '部分历史仅有累计记录，已列入用量来源的“历史未归属”。']);
  else if (s?.accounting?.partial) notes.push(['用量不完整', '历史记录不完整或存在冲突，当前显示可核实的用量。']);
  if (dragError) notes.push(['位置未保存', dragError]);
  if (state.selection.mode === 'recent') notes.push(['正在重连', '正在重新识别当前聊天，暂显示最近活跃聊天。']);
  if (state.selection.mode === 'ambiguous') notes.push(['待选择聊天', '多个窗口或同名聊天无法唯一识别，可在设置中锁定聊天。']);
  if (state.selection.mode === 'empty') notes.push(['暂无聊天', '当前页面没有可绑定的本地聊天，等待进入聊天或产生首次记录。']);
  if (s?.accountingWarning) notes.push(['日志计数回退', '日志有回放或计数回退。累计保留已知上界，速度暂停显示。']);
  if (s?.usageIncomplete) notes.push(['缺少用量基线', '日志缺少初始用量基线，今日统计可能不完整。']);
  if (s?.lastTurn?.speed?.baselineInferred) notes.push(['均速估算', '此轮起始用量由首条请求记录推算，均速为估算值。']);
  if (s?.context.exceeded) notes.push(['上下文超限', '上一轮报告上下文长度超限，可缩短输入或开启新聊天。']);
  if (state.health.indexing) notes.push(['索引中', '正在读取历史日志，当前显示已读取的部分。']);
  if (state.health.readErrors) notes.push(['日志重试中', '部分日志暂不可读，正在自动重试。']);
  if (state.health.truncated) notes.push(['读取受限', '历史文件超过读取上限，今日统计可能不完整。']);
  showNotices(notes);
  const updated = s?.updatedAt ? new Date(s.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : null;
  $('updated').textContent = updated ? `Token 更新于 ${updated} · 只读本地日志` : '只读本地日志 · 等待首次模型响应';
  measure();
}

document.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'details') detailVisibility(!detailsOpen);
  if (action === 'settings') api.settings(event.target.closest('#gear.has-update') ? 'updates' : undefined);
  if (action === 'refresh') api.refresh();
});
$('bar').addEventListener('mouseenter', () => $('bar').classList.add('pointer-near'));
$('bar').addEventListener('mouseleave', () => $('bar').classList.remove('pointer-near'));
$('bar').addEventListener('pointerdown', event => {
  if (!snapshot?.settings.allowDrag || snapshot?.settings.dockToComposer || event.button !== 0 || event.target.closest('button')) return;
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
api.onOpacityPreview(value => { opacityPreview = value; applyOpacity(); });
api.onCompact(layout => { availableWidth = layout.availableWidth; availableHeight = layout.availableHeight; titlebarHeight = layout.titlebarHeight; $('shell').classList.toggle('compact', layout.compact); measure(); });
api.onCollapse(() => $('bar').classList.remove('pointer-near'));
api.onDragError(message => { dragError = message; if (snapshot) render(snapshot); });
api.ready();
