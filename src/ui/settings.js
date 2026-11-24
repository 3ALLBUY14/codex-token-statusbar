'use strict';
const api = window.codexStatusbar;
const $ = id => document.getElementById(id);
const snapshotGuard = new SnapshotGuard();
let current, pane = 'display', chatPage = 0, chatContext = '', lastChatRender = '', resetPatch = null;
let saveGeneration = 0, saveTimer = null, failedSave = null;
let draggedMetric = null, savingMetricOrder = false;
let checkingUpdate = false, manualUpdate = null, updateActionError = '';
const updateNotes = {
  badge: '启动后及每隔 24 小时向 GitHub 查询版本。有新版时，浮条齿轮会亮起。',
  popup: '自动检查并为每个新版弹出一次 Windows 通知，浮条齿轮也会亮起。',
  manual: '点击「检查更新」时向 GitHub 查询版本。',
};
const viewTitles = { display: '浮条外观', metrics: '浮条指标', position: '贴靠与位置', chat: '聊天与上下文', tools: '工具记录', requests: '模型请求', diagnostics: '运行诊断' };
const wideSettings = matchMedia('(min-width: 620px)');
const updateOrientation = () => document.querySelector('.settings-tabs').setAttribute('aria-orientation', wideSettings.matches ? 'vertical' : 'horizontal');
wideSettings.addEventListener('change', updateOrientation);
updateOrientation();
const previewSamples = {
  speed: ['均速', '28.4 t/s'], context: ['上下文', '44.3%'], ttft: ['首 Token', '2.0s'],
  session: ['会话', '1.84M'], turn: ['本轮', '86.4K'], today: ['今日', '6.28M'], cache: ['缓存', '79%'], tools: ['工具', '17'],
};
let lastPreview = '';
const preferenceChoices = [...document.querySelectorAll('[data-choice-for]')];
for (const group of preferenceChoices) {
  const select = $(group.dataset.choiceFor);
  for (const option of select.options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = option.value;
    button.textContent = option.textContent;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-pressed') === 'true') return;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    group.append(button);
  }
}
function renderAppearance(settings) {
  const order = MetricOptions.orderedIds(settings.metricOrder);
  const shown = order.filter(id => settings[MetricOptions.metrics.find(metric => metric.id === id).setting]);
  $('metric-enabled-count').textContent = `已显示 ${shown.length} / ${order.length}`;
  const capsule = $('appearance-capsule');
  capsule.style.setProperty('--preview-scale', String(settings.scale ?? 1));
  capsule.classList.toggle('preview-hide-labels', Boolean(settings.hideLabels));
  if (lastPreview === shown.join(',')) return;
  lastPreview = shown.join(',');
  const metrics = shown.map(id => {
    const metric = document.createElement('span'), label = document.createElement('small'), value = document.createElement('b');
    label.textContent = previewSamples[id][0];
    value.textContent = previewSamples[id][1];
    metric.append(label);
    if (id === 'context') {
      const ring = document.createElement('i');
      ring.className = 'context-ring ok';
      ring.style.setProperty('--context-fill', previewSamples.context[1]);
      ring.setAttribute('aria-hidden', 'true');
      metric.append(ring);
    }
    metric.append(value);
    return metric;
  });
  $('appearance-metrics').replaceChildren(...metrics);
}
const metricList = $('metric-order'), metricRows = new Map();
for (const { id, setting, label } of MetricOptions.metrics) {
  const row = document.createElement('li'), handle = document.createElement('span');
  handle.className = 'metric-handle';
  handle.textContent = '⠿';
  handle.draggable = true;
  handle.title = '拖动调整顺序';
  handle.setAttribute('aria-hidden', 'true');
  handle.addEventListener('dragstart', event => {
    if (savingMetricOrder || !current) { event.preventDefault(); return; }
    draggedMetric = id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  });
  const checkbox = document.createElement('input'), option = document.createElement('label');
  checkbox.type = 'checkbox';
  checkbox.dataset.setting = setting;
  option.append(checkbox, label);
  row.append(handle, option);
  for (const [offset, symbol, move] of [[-1, '↑', '上移'], [1, '↓', '下移']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-button';
    button.textContent = symbol;
    button.setAttribute('aria-label', `${move}${label}`);
    button.addEventListener('click', () => {
      const order = MetricOptions.orderedIds(current?.settings.metricOrder);
      void moveMetric(id, order.indexOf(id) + offset);
    });
    row.append(button);
  }
  row.addEventListener('dragover', event => {
    if (!draggedMetric || draggedMetric === id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', event => { if (!row.contains(event.relatedTarget)) row.classList.remove('drop-target'); });
  row.addEventListener('drop', event => {
    event.preventDefault();
    row.classList.remove('drop-target');
    if (draggedMetric) void moveMetric(draggedMetric, MetricOptions.orderedIds(current.settings.metricOrder).indexOf(id));
  });
  metricRows.set(id, row);
  metricList.append(row);
}
metricList.addEventListener('dragend', () => {
  draggedMetric = null;
  for (const row of metricRows.values()) row.classList.remove('drop-target');
});
function showMetricOrder(order) {
  const focused = document.activeElement;
  const focusedRow = metricList.contains(focused) ? focused.closest('li') : null;
  order.forEach((id, index) => {
    const row = metricRows.get(id);
    if (metricList.children[index] !== row) metricList.insertBefore(row, metricList.children[index] ?? null);
    row.children[2].disabled = index === 0;
    row.children[3].disabled = index === order.length - 1;
  });
  if (focusedRow && (focused.disabled || focused !== document.activeElement)) {
    const target = focused.disabled ? focusedRow.querySelector('button:not(:disabled)') : focused;
    target?.focus({ preventScroll: true });
  }
}
async function moveMetric(id, target) {
  if (!current || savingMetricOrder) return;
  const order = [...MetricOptions.orderedIds(current.settings.metricOrder)], start = order.indexOf(id);
  if (start < 0 || target < 0 || target >= order.length || target === start) return;
  order.splice(start, 1);
  order.splice(target, 0, id);
  resetPatch = null;
  $('undo-reset').hidden = true;
  $('reset-message').textContent = '';
  await saveAction(async () => {
    savingMetricOrder = true;
    try { await api.setSettings({ metricOrder: order }); }
    finally { savingMetricOrder = false; }
  });
}
const labels = { following: '跟随当前聊天', recent: '当前聊天未绑定，显示最近活跃聊天', pinned: '已锁定聊天', ambiguous: '多个窗口或同名聊天，请选择聊天', empty: '当前页面暂无本地聊天数据', unbound: '等待首次聊天记录' };
function showPane(name) {
  if (!Object.hasOwn(viewTitles, name)) return;
  pane = name;
  $('settings-pane-title').textContent = viewTitles[name];
  for (const button of document.querySelectorAll('[data-tab]')) { const selected = button.dataset.tab === name; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
  for (const panel of document.querySelectorAll('[data-pane]')) panel.hidden = panel.dataset.pane !== name;
  api.toolInterest(name === 'tools');
  window.requestPanel.update(current, name === 'requests');
  $('settings-scroll').scrollTop = 0;
}
function renderUpdateStatus() {
  const update = current?.update?.checking ? current.update : manualUpdate ?? current?.update;
  const busy = checkingUpdate || Boolean(update?.checking);
  const available = current?.update?.newer || update?.newer;
  const status = $('update-status');
  const text = busy ? '正在检查 GitHub 发布…' : updateActionError || (update?.newer ? `发现新版 ${update.tag}` : update?.ok ? `已是最新版本 · ${update.tag}` : update?.message ?? '尚未检查更新');
  if (status.textContent !== text) status.textContent = text;
  status.classList.toggle('available', Boolean(!busy && update?.newer && !updateActionError));
  $('check-update').disabled = busy;
  $('open-release').classList.toggle('update-download', Boolean(available));
}
for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => showPane(tab.dataset.tab));
  tab.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('[data-tab]')]; let index = tabs.indexOf(tab);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault(); showPane(tabs[index].dataset.tab); tabs[index].focus();
  });
}
function renderChats() {
  if (!current) return;
  const query = $('chat-search').value.trim().toLocaleLowerCase();
  const context = JSON.stringify([query, current.settings.pinnedThreadId]);
  if (context !== chatContext) { chatContext = context; chatPage = 0; }
  const rows = [...current.sessions], pinned = current.settings.pinnedThreadId;
  if (pinned && !rows.some(item => item.id === pinned)) rows.push({ id: pinned, title: '已锁定，等待本地日志', model: null, tokens: null });
  const matches = rows.filter(item => `${item.title ?? ''} ${item.model ?? ''} ${item.id}`.toLocaleLowerCase().includes(query));
  const pages = Math.max(1, Math.ceil(matches.length / 20)); chatPage = Math.min(chatPage, pages - 1);
  const shown = matches.slice(chatPage * 20, (chatPage + 1) * 20);
  if (pinned && !shown.some(item => item.id === pinned)) shown.push(rows.find(item => item.id === pinned));
  const signature = JSON.stringify([shown, pinned, query, chatPage]);
  if (signature !== lastChatRender && document.activeElement !== $('chat')) {
    lastChatRender = signature; $('chat').replaceChildren(new Option('自动跟随当前聊天', ''));
    for (const item of shown) $('chat').add(new Option(`${item.active ? '● ' : ''}${item.title ?? '未命名聊天'} · ${item.model ?? '模型待记录'} · ${item.id.slice(0, 8)} · ${item.tokens?.toLocaleString('zh-CN') ?? '—'} Token`, item.id));
    $('chat').value = pinned ?? '';
  }
  $('chat-page').textContent = `${chatPage + 1} / ${pages} 页 · ${matches.length} 个匹配聊天`;
  $('chat-prev').disabled = chatPage === 0; $('chat-next').disabled = chatPage >= pages - 1;
}
api.onSnapshot(state => {
  if (!snapshotGuard.accept(state)) return;
  current = state; document.documentElement.classList.toggle('light', !state.dark);
  const appIcon = $('settings-app-icon');
  if (state.appIconName && !appIcon.hasAttribute('src')) appIcon.src = `../../assets/icons/${state.appIconName}.svg`;
  if (!checkingUpdate && state.update?.ok) manualUpdate = null;
  $('update-mode-note').textContent = updateNotes[state.settings.updateMode] ?? '';
  renderUpdateStatus();
  showMetricOrder(MetricOptions.orderedIds(state.settings.metricOrder));
  renderAppearance(state.settings);
  renderUsageDetails($('settings-usage-details'), state.session);
  $('diag-state').textContent = state.diagnostic?.label ?? '正在检查';
  $('diag-state-note').textContent = state.diagnostic?.detail ?? '';
  for (const input of document.querySelectorAll('[data-setting]')) {
    if (input === document.activeElement || input.id === 'chat') continue;
    const value = state.settings[input.dataset.setting];
    if (input.type === 'checkbox') input.checked = value; else input.value = input.id === 'opacity' ? Math.round((value ?? 1) * 100) : value ?? '';
  }
  for (const group of preferenceChoices) {
    const selected = $(group.dataset.choiceFor).value;
    for (const button of group.children) button.setAttribute('aria-pressed', String(button.dataset.value === selected));
  }
  opacityLabel();
  $('composer-alignment').disabled = !state.settings.dockToComposer;
  $('dock-target').disabled = !state.settings.dockToComposer;
  for (const key of ['placement', 'allowDrag', 'offsetX', 'offsetY', 'alwaysVisible', 'rememberDisplayPositions']) document.querySelector(`[data-setting="${key}"]`).disabled = state.settings.dockToComposer;
  const titlebar = state.settings.dockTarget === 'titlebar';
  const docking = { titlebar: '已贴靠标题栏内，明细向下展开', below: '已贴靠输入框下方', above: '下方空间不足，已贴靠上方', waiting: `等待识别${titlebar ? '标题栏空白区域' : '输入框'}，浮条暂时隐藏`, 'host-hidden': 'Codex 不在前台，贴靠浮条已隐藏' };
  $('composer-note').textContent = state.settings.dockToComposer ? `${docking[state.runtime?.composerDock] ?? '正在识别贴靠区域'}。关闭贴靠可恢复自由浮动。` : '标题栏内向下展开，输入框附近随空间调整位置。';
  renderChats(); window.toolPanel.update(state);
  window.requestPanel.update(state, pane === 'requests');
  $('connection').textContent = `${state.selection.connected ? '已连接 · ' : ''}${labels[state.selection.mode]} · ${state.health.sessionCount} 个本地聊天`;
  const runtime = state.runtime ?? {};
  $('diag-version').textContent = runtime.version ?? '—';
  $('diag-connection').textContent = state.selection.connected ? `已连接，${labels[state.selection.mode]}` : `${labels[state.selection.mode]}；IPC 连接正在重试`;
  const sources = { 'desktop-navigation': '页面路径 / 聊天 ID', 'visible-document-title': '页面标题备用匹配' };
  $('diag-source').textContent = state.selection.mode === 'pinned' ? '手动锁定' : sources[state.selection.source] ?? '等待页面识别';
  $('diag-confidence').textContent = state.selection.mode === 'pinned' ? '手动确认' : { route: '页面 ID 已确认', title: '标题唯一匹配', 'cached-title': '沿用已确认聊天（索引暂不可读）', uncertain: '身份不确定，请选择聊天' }[state.selection.confidence] ?? '等待确认';
  $('diag-title').textContent = state.selection.title ?? '尚未取得聊天标题';
  $('diag-window').textContent = runtime.testMode ? '界面测试模式' : runtime.watcherError ? runtime.watcherError : runtime.watcherRunning && !runtime.watcherLastSampleAt ? '跟随助手启动中' : runtime.watcherRunning && !runtime.watcherHealthy ? '跟随助手无响应，正在重启' : runtime.watcherRunning ? runtime.codexForeground ? '正在跟随前台 Codex' : '助手正常，Codex 不在前台或已最小化' : '跟随助手重启中';
  $('diag-window-updated').textContent = runtime.watcherLastSampleAt ? `最近响应：${new Date(runtime.watcherLastSampleAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '等待首次响应';
  $('diag-helper').textContent = runtime.testMode ? '界面测试模式' : runtime.watcherBackend === 'independent' ? '独立 Windows 助手' : runtime.watcherBackend === 'powershell' ? 'PowerShell 兼容助手' : '等待启动';
  $('diag-title-channel').textContent = runtime.testMode ? '界面测试模式' : runtime.titleError ?? (runtime.titleHealthy ? '正常' : '正在连接；页面 ID 识别仍可用');
  const indexError = runtime.indexError;
  $('diag-index').textContent = indexError ? `${indexError === 'size-limit' ? '索引超过读取上限' : indexError === 'ENOENT' ? '索引暂不存在' : '索引暂不可读'}${runtime.indexCached ? '，已保留缓存' : ''}` : '正常';
  $('diag-cache').textContent = state.health.cacheError ? '缓存暂不可用，已直接读取日志' : `已复用 ${state.health.cacheHits ?? 0} 个历史日志`;
  $('diag-display').textContent = `${runtime.displayCount ?? 1} 个 · 当前缩放 ${Math.round((runtime.displayScale ?? 1) * 100)}%`;
  $('diag-overlay').textContent = runtime.overlayVisible ? '正在显示' : runtime.manuallyHidden ? '已手动隐藏' : !state.settings.alwaysVisible && !runtime.codexForeground ? '按设置自动隐藏' : '暂未显示';
  $('diag-layer').textContent = state.settings.desktopCompatibility ? runtime.overlayTopmost ? '加强置顶已启用' : '加强置顶已启用，等待层级恢复' : '普通置顶';
  $('diag-composer').textContent = state.settings.dockToComposer ? docking[runtime.composerDock] ?? '正在识别输入框' : '未启用';
  $('diag-logs').textContent = `${state.health.fileCount} 个文件 / ${state.health.sessionCount} 个聊天${state.health.readErrors ? ' · ' + state.health.readErrors + ' 个读取错误' : ''}${state.health.indexing ? ' · 索引中' : ''}`;
  $('diag-updated').textContent = state.session?.updatedAt ? new Date(state.session.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '等待首次模型响应';
  $('diag-advice').textContent = state.health.readErrors ? '部分目录或日志暂不可读，已保留可用缓存；统计可能不完整，程序会自动重试。' : state.selection.reason === 'duplicate-title' ? '同名聊天缺少近期页面确认，请在“聊天”中锁定目标，或重新进入目标聊天。' : !state.selection.connected ? 'IPC 连接正在重试；页面路径和标题识别仍可独立工作。' : state.selection.mode === 'ambiguous' ? '多个窗口或同名聊天无法唯一识别，请在“聊天”中锁定目标。' : (!runtime.watcherHealthy || runtime.watcherError) && !runtime.testMode ? '窗口跟随助手会自动重启；“始终显示”可暂时保持浮条可见。' : !runtime.overlayVisible && !state.settings.alwaysVisible && !runtime.codexForeground ? '切回 Codex 后浮条会自动显示。' : '运行状态正常；空闲聊天的 Token 更新时间可以早于当前时间。';
  if (indexError && !state.health.readErrors) $('diag-advice').textContent = '聊天标题索引读取受限，已保留可用标题；已确认聊天可继续显示，新切换聊天需页面 ID 确认，也可手动锁定。程序会自动重试。';
});
async function saveAction(action) {
  const generation = ++saveGeneration;
  clearTimeout(saveTimer); failedSave = null; $('retry-save').hidden = true;
  $('save-feedback').dataset.state = 'saving'; $('save-status').textContent = '正在保存…';
  try {
    await action();
    if (generation === saveGeneration) {
      $('save-feedback').dataset.state = 'saved'; $('save-status').textContent = '已保存';
      saveTimer = setTimeout(() => { $('save-feedback').dataset.state = 'idle'; $('save-status').textContent = '更改会自动保存'; }, 2500);
    }
    return true;
  } catch (error) {
    if (generation === saveGeneration) {
      failedSave = action; $('retry-save').hidden = false;
      $('save-feedback').dataset.state = 'error'; $('save-status').textContent = error.message || '设置未能保存，请重试。';
    }
    return false;
  }
}
const save = patch => saveAction(() => api.setSettings(patch));
$('retry-save').addEventListener('click', () => { if (failedSave) void saveAction(failedSave); });
function opacityLabel() {
  const value = `${$('opacity').value}%`;
  $('opacity-value').textContent = value;
  $('opacity').setAttribute('aria-valuetext', value);
  $('appearance-capsule').style.opacity = Number($('opacity').value) / 100;
}
$('opacity').addEventListener('input', () => { opacityLabel(); api.previewOpacity(Number($('opacity').value) / 100); });
$('opacity').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault(); $('opacity').value = Math.round((current?.settings.opacity ?? 1) * 100); opacityLabel(); api.previewOpacity(null);
});
$('opacity').addEventListener('blur', () => api.previewOpacity(null));
document.addEventListener('change', async event => {
  const input = event.target, key = input.dataset.setting;
  if (!key) return;
  resetPatch = null; $('undo-reset').hidden = true; $('reset-message').textContent = '';
  let value = input.type === 'checkbox' ? input.checked : input.value;
  if (['scale', 'offsetX', 'offsetY', 'contextOverride'].includes(key)) value = value === '' ? null : Number(value);
  if (key === 'pinnedThreadId') value ||= null;
  if (key === 'opacity') value = Number(value) / 100;
  const saved = await save({ [key]: value });
  if (key === 'opacity' && !saved) { input.value = Math.round((current?.settings.opacity ?? 1) * 100); opacityLabel(); api.previewOpacity(null); }
});
$('chat-search').addEventListener('input', renderChats);
$('chat').addEventListener('blur', renderChats);
$('chat-prev').addEventListener('click', () => { chatPage--; renderChats(); });
$('chat-next').addEventListener('click', () => { chatPage++; renderChats(); });
$('open-tool-details').addEventListener('click', event => { event.preventDefault(); showPane('tools'); });
for (const link of document.querySelectorAll('.settings-links a')) {
  link.addEventListener('click', async event => {
    event.preventDefault();
    $('settings-link-status').textContent = '';
    try { await api.openSettingsLink(link.href); }
    catch { $('settings-link-status').textContent = '未能打开浏览器'; }
  });
}
$('refresh').addEventListener('click', () => api.refresh());
$('restore-position').addEventListener('click', () => { void saveAction(() => api.restorePosition()); });
$('quit').addEventListener('click', () => api.quit());
$('reset').addEventListener('click', async () => {
  if (!current) return;
  const defaults = { theme: 'system', scale: 1, opacity: 1, showSpeed: true, showContext: true, showTtft: false, showSession: true, showTurn: false, showToday: false, showCache: false, showTools: false, hideLabels: false, metricOrder: MetricOptions.defaultOrder };
  const previous = Object.fromEntries(Object.keys(defaults).map(key => [key, current.settings[key]]));
  if (await save(defaults)) { resetPatch = previous; $('undo-reset').hidden = false; $('reset-message').textContent = '显示项已恢复默认，聊天锁定、窗口容量和浮条位置保留。'; }
});
$('undo-reset').addEventListener('click', async () => { if (resetPatch && await save(resetPatch)) { resetPatch = null; $('undo-reset').hidden = true; $('reset-message').textContent = '已撤销恢复默认显示。'; } });
$('copy-diagnostics').addEventListener('click', async () => { try { await api.copyDiagnostics(); $('diagnostic-action-status').textContent = '诊断已复制，可粘贴给开发者。'; } catch { $('diagnostic-action-status').textContent = '未能复制诊断，请稍后重试。'; } });
$('check-update').addEventListener('click', async () => {
  checkingUpdate = true;
  updateActionError = '';
  renderUpdateStatus();
  try {
    const result = await api.checkUpdate();
    if (result.ok) manualUpdate = result;
    else updateActionError = result.message;
  } catch { updateActionError = '暂时无法检查更新，可直接打开下载页。'; }
  finally {
    checkingUpdate = false;
    renderUpdateStatus();
  }
});
$('open-release').addEventListener('click', async () => {
  updateActionError = '';
  try { await api.openRelease(); }
  catch { updateActionError = '无法打开浏览器，请手动访问 GitHub 发布页。'; }
  renderUpdateStatus();
});
api.onShowUpdates(() => {
  showPane('diagnostics');
  $('update-heading').focus({ preventScroll: true });
});
api.onRequestFilters(() => {
  showPane('requests');
  $('request-from').closest('details').open = true;
  $('request-from').focus({ preventScroll: true });
});
api.ready();
