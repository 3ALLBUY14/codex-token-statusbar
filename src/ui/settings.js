'use strict';
const api = window.codexStatusbar;
let lastList = '';
let toolState = null;
let lastToolRender = '';
let lastToolContext = '';
const formatCount = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
const formatDuration = value => Number.isFinite(value) ? `${(value / 1000).toFixed(1)}s` : '未记录';

function renderTools() {
  if (!toolState) return;
  const state = toolState;
  const session = state.session;
  const turn = document.getElementById('tool-scope').value === 'turn';
  const failedOnly = document.getElementById('tool-failed-only').checked;
  const stats = turn ? session?.turnToolUsage : session?.toolUsage;
  const signature = JSON.stringify([state.selection, stats, session?.active, turn, failedOnly]);
  if (signature === lastToolRender) return;
  lastToolRender = signature;
  const modes = { following: '跟随当前聊天', pinned: '已锁定聊天', recent: '最近活跃聊天', empty: '当前页面暂无聊天数据', ambiguous: '请先选择聊天', unbound: '等待聊天数据' };
  document.getElementById('tool-chat').textContent = [modes[state.selection.mode], state.selection.title ?? session?.model].filter(Boolean).join(' · ');
  document.getElementById('tool-turn-option').textContent = session?.active ? '本轮' : '上一轮';
  const summary = stats ? `${formatCount(stats.total)} 次 · 失败 ${formatCount(stats.failed)} 次` : '暂无调用数据';
  document.getElementById('tool-details-summary').textContent = `查看分类与调用记录 · ${summary}`;
  document.getElementById('tool-stats').textContent = stats ? `${turn ? session.active ? '本轮' : '上一轮' : '会话累计'} ${summary} · 有耗时记录 ${formatCount(stats.timed)} 次 / ${formatDuration(stats.durationMs)}` : '当前范围暂无已完成的工具调用。';
  const groups = document.getElementById('settings-tool-groups');
  groups.replaceChildren();
  for (const group of stats?.byType ?? []) {
    const row = document.createElement('tr');
    for (const value of [group.label, formatCount(group.total), formatCount(group.failed), formatCount(group.timed), group.timed ? formatDuration(group.durationMs) : '未记录']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    groups.append(row);
  }
  const records = stats?.records ?? [];
  const visible = [...records].reverse().filter(record => !failedOnly || record.status === 'failed');
  document.getElementById('tool-record-note').textContent = `保留当前范围最近 200 条完成记录，汇总统计包含全部调用。${stats?.total > records.length ? ` 当前保留 ${records.length} / ${formatCount(stats.total)} 条。` : ''}`;
  const list = document.getElementById('settings-tool-records');
  const context = JSON.stringify([state.selection.threadId, turn, failedOnly]);
  const scrollTop = context === lastToolContext ? list.scrollTop : 0;
  lastToolContext = context;
  list.replaceChildren();
  for (const record of visible) {
    const row = document.createElement('li');
    const heading = document.createElement('div');
    heading.className = 'tool-record-top';
    const name = document.createElement('strong');
    name.textContent = `#${formatCount(record.sequence)} ${record.label}`;
    const status = document.createElement('span');
    status.className = `tool-record-status${record.status === 'failed' ? ' failed' : ''}`;
    status.textContent = record.status === 'failed' ? '失败' : '已完成';
    heading.append(name, status);
    const metadata = document.createElement('p');
    metadata.className = 'tool-record-meta';
    const timestamp = record.timestamp ? new Date(record.timestamp).toLocaleString('zh-CN', { hour12: false }) : '完成时间未记录';
    metadata.textContent = `${timestamp} · 耗时 ${formatDuration(record.durationMs)}${record.exitCode !== null && record.exitCode !== undefined ? ` · 退出码 ${record.exitCode}` : ''}`;
    row.append(heading, metadata);
    list.append(row);
  }
  list.scrollTop = scrollTop;
  document.getElementById('tool-empty').textContent = visible.length ? '' : !stats?.total ? '暂无已完成的工具调用；运行中的调用会在完成后显示。' : failedOnly ? '保留的记录中没有失败调用。' : '暂无可显示的完成记录。';
}

api.onSnapshot(state => {
  toolState = state;
  renderTools();
  document.documentElement.classList.toggle('light', !state.dark);
  for (const input of document.querySelectorAll('[data-setting]')) {
    if (input === document.activeElement || input.id === 'chat') continue;
    const value = state.settings[input.dataset.setting];
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value ?? '';
  }
  const signature = JSON.stringify([state.sessions, state.settings.pinnedThreadId]);
  if (signature !== lastList && document.activeElement?.id !== 'chat') {
    lastList = signature;
    const select = document.getElementById('chat');
    select.replaceChildren(new Option('自动跟随当前聊天', ''));
    const rows = [...state.sessions];
    if (state.settings.pinnedThreadId && !rows.some(item => item.id === state.settings.pinnedThreadId)) rows.push({ id: state.settings.pinnedThreadId, model: '等待日志', tokens: null });
    for (const item of rows) select.add(new Option(`${item.active ? '● ' : ''}${item.id.slice(0, 8)} · ${item.model ?? '模型待记录'} · ${item.tokens?.toLocaleString('zh-CN') ?? '—'} Token`, item.id));
    select.value = state.settings.pinnedThreadId ?? '';
  }
  const labels = { following: '跟随当前聊天', recent: '当前聊天未绑定，显示最近活跃聊天', pinned: '已锁定聊天', ambiguous: '多个窗口或同名聊天，请选择聊天', empty: '当前页面暂无本地聊天数据', unbound: '等待首次聊天记录' };
  document.getElementById('connection').textContent = `${state.selection.connected ? '已连接 · ' : ''}${labels[state.selection.mode]} · ${state.health.sessionCount} 个本地聊天`;
  const runtime = state.runtime ?? {};
  document.getElementById('diag-version').textContent = runtime.version ?? '—';
  document.getElementById('diag-connection').textContent = state.selection.connected ? `已连接，${labels[state.selection.mode]}` : `${labels[state.selection.mode]}；IPC 连接正在重试`;
  const sources = { 'desktop-navigation': '页面路径 / 聊天 ID', 'visible-document-title': '页面标题备用匹配' };
  document.getElementById('diag-source').textContent = state.selection.mode === 'pinned' ? '手动锁定' : sources[state.selection.source] ?? '等待页面识别';
  document.getElementById('diag-title').textContent = state.selection.title ?? '尚未取得聊天标题';
  document.getElementById('diag-window').textContent = runtime.testMode ? '界面测试模式' : runtime.watcherError ? runtime.watcherError : runtime.watcherRunning && !runtime.watcherLastSampleAt ? '跟随助手启动中' : runtime.watcherRunning && !runtime.watcherHealthy ? '跟随助手无响应，正在重启' : runtime.watcherRunning ? runtime.codexForeground ? '正在跟随前台 Codex' : '助手正常，Codex 不在前台或已最小化' : '跟随助手重启中';
  document.getElementById('diag-window-updated').textContent = runtime.watcherLastSampleAt ? `最近响应：${new Date(runtime.watcherLastSampleAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '等待首次响应';
  document.getElementById('diag-overlay').textContent = runtime.overlayVisible ? '正在显示' : runtime.manuallyHidden ? '已手动隐藏' : !state.settings.alwaysVisible && !runtime.codexForeground ? '按设置自动隐藏' : '暂未显示';
  document.getElementById('diag-logs').textContent = `${state.health.fileCount} 个文件 / ${state.health.sessionCount} 个聊天${state.health.readErrors ? ` · ${state.health.readErrors} 个读取错误` : ''}${state.health.indexing ? ' · 索引中' : ''}`;
  document.getElementById('diag-updated').textContent = state.session?.updatedAt ? new Date(state.session.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '等待首次模型响应';
  document.getElementById('diag-advice').textContent = !state.selection.connected ? 'IPC 连接正在重试；页面路径和标题识别仍可独立工作。也可点击“重新检测与刷新”。' : state.selection.mode === 'ambiguous' ? '多个窗口或同名聊天无法唯一识别，可在上方选择并锁定目标聊天。' : (!runtime.watcherHealthy || runtime.watcherError) && !runtime.testMode ? '窗口跟随助手会自动重启；“始终显示”可暂时保持浮条可见。' : runtime.manuallyHidden ? '从托盘菜单选择“显示浮条”，或点击“恢复浮条位置”。' : !runtime.overlayVisible && !state.settings.alwaysVisible && !runtime.codexForeground ? '切回 Codex 后浮条会自动显示。' : state.health.readErrors ? '部分日志暂不可读，程序会自动重试。' : '运行状态正常；空闲聊天的 Token 更新时间可以早于当前时间。';
});

async function save(patch) {
  try { await api.setSettings(patch); document.getElementById('save-status').textContent = ''; }
  catch (error) { document.getElementById('save-status').textContent = error.message || '设置未能保存，请稍后重试。'; }
}
document.addEventListener('change', event => {
  const input = event.target;
  const key = input.dataset.setting;
  if (!key) return;
  let value = input.type === 'checkbox' ? input.checked : input.value;
  if (['scale', 'offsetX', 'offsetY', 'contextOverride'].includes(key)) value = value === '' ? null : Number(value);
  if (key === 'pinnedThreadId') value ||= null;
  save({ [key]: value });
});
document.getElementById('refresh').addEventListener('click', () => api.refresh());
document.getElementById('tool-scope').addEventListener('change', renderTools);
document.getElementById('tool-failed-only').addEventListener('change', renderTools);
document.getElementById('open-tool-details').addEventListener('click', () => { document.getElementById('tool-details').open = true; });
document.getElementById('restore-position').addEventListener('click', () => api.restorePosition());
document.getElementById('quit').addEventListener('click', () => api.quit());
document.getElementById('reset').addEventListener('click', () => save({ theme: 'system', placement: 'top-right', scale: 1, alwaysVisible: false, showSpeed: true, showContext: true, showSession: true, showTurn: false, showToday: false, showCache: false, showTools: false, pinnedThreadId: null, contextOverride: null, offsetX: 0, offsetY: 0, allowDrag: false, hideLabels: false }));
api.ready();
