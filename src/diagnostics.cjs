'use strict';
const RELEASE_URL = 'https://github.com/3ALLBUY14/codex-token-statusbar/releases/latest';
const UPDATE_URL = 'https://api.github.com/repos/3ALLBUY14/codex-token-statusbar/releases/latest';
function versionParts(value) {
  const match = /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value ?? '');
  const parts = match ? match.slice(1).map(part => Number(part ?? 0)) : null;
  return parts?.every(Number.isSafeInteger) ? parts : null;
}
function newerVersion(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function diagnosticSummary(state, platform) {
  const s = state ?? {}, runtime = s.runtime ?? {}, health = s.health ?? {};
  // Explicit allowlist: no titles, IDs, paths, tool names, arguments or output.
  return JSON.stringify({
    version: runtime.version ?? null, platform,
    selection: { mode: s.selection?.mode, source: s.selection?.source, confidence: s.selection?.confidence, connected: Boolean(s.selection?.connected) },
    watcher: { running: Boolean(runtime.watcherRunning), healthy: Boolean(runtime.watcherHealthy), backend: runtime.watcherBackend ?? null, titleHealthy: Boolean(runtime.titleHealthy), overlayVisible: Boolean(runtime.overlayVisible) },
    logs: { fileCount: health.fileCount, sessionCount: health.sessionCount, readErrors: health.readErrors, indexing: Boolean(health.indexing), truncated: Boolean(health.truncated), indexError: runtime.indexError ?? null, cacheHits: health.cacheHits ?? 0, cacheError: health.cacheError ?? null },
    displays: { count: runtime.displayCount ?? null, scale: runtime.displayScale ?? null },
    overlay: { desktopCompatibility: Boolean(runtime.desktopCompatibility), topmost: Boolean(runtime.overlayTopmost), composerDock: runtime.composerDock ?? 'off' },
    tokensUpdatedAt: s.session?.updatedAt ?? null,
    status: diagnosticState(s),
    accounting: { method: s.session?.accounting?.method ?? 'legacy', partial: Boolean(s.session?.accounting?.partial), relatedThreads: s.session?.accounting?.relatedThreads ?? 0 },
    tools: { completed: s.session?.toolUsage?.total ?? 0, failed: s.session?.toolUsage?.failed ?? 0 },
  }, null, 2);
}
function diagnosticState(state) {
  const s = state ?? {}, r = s.runtime ?? {}, h = s.health ?? {}, selection = s.selection ?? {};
  if (r.manuallyHidden) return { code: 'hidden', label: '已手动隐藏', detail: '可从托盘或设置恢复浮条。' };
  if (!r.testMode && (!r.watcherHealthy || r.watcherError)) return { code: 'window-retrying', label: '窗口跟随恢复中', detail: '窗口助手会自动重启；可暂时关闭贴靠并启用始终显示。' };
  if (s.settings?.dockToComposer && r.composerDock === 'waiting') return { code: 'dock-waiting', label: '等待贴靠区域', detail: `未识别到${s.settings.dockTarget === 'titlebar' ? '标题栏安全区域' : '输入框'}，浮条保持隐藏以免遮挡；可切换区域或关闭贴靠。` };
  if (selection.mode === 'ambiguous') return { code: 'selection-ambiguous', label: '聊天尚未确认', detail: '多个窗口或同名聊天无法唯一识别，请在聊天页锁定目标。' };
  if (h.readErrors) return { code: 'read-retrying', label: '日志读取受限', detail: '保留已读取结果并自动重试，统计可能不完整。' };
  if (h.indexing) return { code: 'indexing', label: '正在读取历史记录', detail: '当前显示已读取部分，读取完成后自动更新。' };
  if (!s.session) return { code: 'waiting-data', label: selection.threadId ? '已识别聊天，等待日志' : '等待聊天', detail: selection.threadId ? '当前聊天尚无可读取的本地用量记录，不沿用上一聊天的数据。' : '进入一个已有记录的聊天后自动更新。' };
  if (s.session.accounting?.partial) return { code: 'usage-partial', label: '已记录范围不完整', detail: '部分历史或响应记录缺失、冲突；用量明细仅展示可核实记录。' };
  if (h.cacheError) return { code: 'cache-fallback', label: '已直接读取日志', detail: '统计缓存暂不可用，当前结果来自日志，后续启动可能较慢。' };
  if (!selection.connected) return { code: 'ipc-retrying', label: '聊天连接恢复中', detail: 'IPC 正在重试；页面路径和标题识别仍可独立工作。' };
  return { code: 'ready', label: '数据已同步', detail: '空闲聊天的 Token 更新时间可以早于当前时间。' };
}
module.exports = { RELEASE_URL, UPDATE_URL, versionParts, newerVersion, diagnosticSummary, diagnosticState };
