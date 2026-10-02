'use strict';
const api = window.codexStatusbar;
let lastList = '';
api.onSnapshot(state => {
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
document.getElementById('restore-position').addEventListener('click', () => api.restorePosition());
document.getElementById('quit').addEventListener('click', () => api.quit());
document.getElementById('reset').addEventListener('click', () => save({ theme: 'system', placement: 'top-right', scale: 1, alwaysVisible: false, showSpeed: true, showContext: true, showSession: true, showTurn: false, showToday: false, showCache: false, showTools: false, pinnedThreadId: null, contextOverride: null, offsetX: 0, offsetY: 0, allowDrag: false, hideLabels: false }));
api.ready();
