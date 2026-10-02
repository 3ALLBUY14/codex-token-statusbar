'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme, screen, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SessionStore } = require('./session-store.cjs');
const { CodexIpc } = require('./codex-ipc.cjs');
const { DesktopNavigation } = require('./desktop-navigation.cjs');
const { VisibleChat, resolveVisibleSelection } = require('./visible-chat.cjs');
const { SettingsStore } = require('./settings.cjs');
const { contextStatus } = require('./metrics.cjs');

app.setName('Codex Token Statusbar');
const displayVersion = require('../package.json').displayVersion ?? app.getVersion();
const smoke = process.argv.includes('--smoke');
const demo = process.argv.includes('--demo');
const smokeAt = process.argv.indexOf('--artifacts');
const artifactDirectory = smokeAt >= 0 ? path.resolve(process.argv[smokeAt + 1]) : path.join(__dirname, '..', 'artifacts');
if (smoke || demo) app.setPath('userData', path.join(artifactDirectory, smoke ? 'smoke-profile' : 'demo-profile'));
else app.setPath('userData', path.join(app.getPath('appData'), 'CodexTokenStatusbar'));

let overlay, settingsWindow, tray, store, ipc, navigation, visibleChat, settings, nativeWatcher, lastHost, latest, publishTimer;
let overlaySize = { width: 600, height: 56 };
let quitting = false;
let overlayLoaded = false;
let manuallyHidden = false;
let hostVisible = false;
let ownForeground = false;
let geometryTimer;
let previewFixture = false;
let compactLayout = null;
let dragSession = null;
let watcherStartedAt = 0;
let watcherLastSampleAt = 0;
let watcherError = null;
let watcherWatchdog;

function runtimeStatus() {
  const watcherRunning = Boolean(nativeWatcher?.pid && !nativeWatcher.killed);
  return {
    version: displayVersion,
    watcherRunning,
    watcherHealthy: watcherRunning && watcherLastSampleAt > 0 && Date.now() - watcherLastSampleAt < 7000,
    watcherLastSampleAt: watcherLastSampleAt || null,
    watcherError,
    codexForeground: hostVisible,
    overlayVisible: Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible()),
    manuallyHidden,
    testMode: smoke || demo,
  };
}

const validSender = event => [overlay, settingsWindow].some(win => win && !win.isDestroyed() && win.webContents === event.sender);

function publish() {
  if (!store || quitting) return;
  const route = navigation?.status();
  const selection = route ? { ...ipc.status(), ...resolveVisibleSelection(route, visibleChat.status(navigation.processId), Boolean(visibleChat.titleForId(route.threadId))) } : ipc.status();
  latest = store.snapshot(settings.value, selection);
  latest.selection.title = visibleChat?.titleForId(latest.selection.threadId) ?? null;
  latest.settings = settings.value;
  latest.runtime = runtimeStatus();
  if (process.argv.includes('--health-report')) {
    try {
      fs.mkdirSync(artifactDirectory, { recursive: true });
      fs.writeFileSync(path.join(artifactDirectory, 'running-health.json'), JSON.stringify({
        pid: process.pid, updatedAt: new Date().toISOString(), ipcConnected: ipc.connected,
        selected: Boolean(latest.selection.threadId), routeCount: ipc.routes.size,
        selectionSource: latest.selection.source, navigationKnown: navigation?.status().known ?? false,
        selectionMode: latest.selection.mode, hasUsage: latest.session?.hasUsage ?? false,
        pinned: Boolean(settings.value.pinnedThreadId),
        watcherRunning: latest.runtime.watcherRunning, watcherHealthy: latest.runtime.watcherHealthy,
      }, null, 2));
    } catch { /* Optional diagnostics must not interrupt the overlay. */ }
  }
  latest.dark = settings.value.theme === 'dark' || settings.value.theme === 'system' && nativeTheme.shouldUseDarkColors;
  if (settings.value.contextOverride && latest.session) {
    latest.session.context.capacity = settings.value.contextOverride;
    latest.session.context.percent = latest.session.context.used === null ? null : latest.session.context.used * 100 / settings.value.contextOverride;
    latest.session.context.overridden = true;
    Object.assign(latest.session.context, contextStatus(latest.session.context.percent, settings.value.contextOverride));
  }
  const displayState = previewFixture || demo ? demoState() : latest;
  for (const win of [overlay, settingsWindow]) if (win && !win.isDestroyed()) win.webContents.send('statusbar:snapshot', displayState);
  if (tray) {
    const total = latest.session?.hasUsage ? latest.session.totals.total_tokens.toLocaleString('zh-CN') : '—';
    tray.setToolTip(`Codex Token 状态条\n会话 ${total} tokens\n上下文 ${latest.session?.context.percent?.toFixed(1) ?? '—'}%`);
  }
}
function queuePublish() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(publish, 100);
}

function anchorPosition(host, size, placement) {
  return {
    x: placement === 'bottom-center' ? host.x + (host.width - size.width) / 2 : host.x + host.width - size.width - 18,
    y: placement === 'top-right' ? host.y + 52 : host.y + host.height - size.height - 22,
  };
}

function dragOverlay(action, point) {
  if (action === 'start') {
    if (!settings.value.allowDrag || !overlay.isVisible()) return;
    const cursor = point && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) < 100000 && Math.abs(point.y) < 100000 ? point : screen.getCursorScreenPoint();
    dragSession = { cursor, bounds: overlay.getBounds(), moved: false };
    return;
  }
  if (!dragSession) return;
  if (action === 'move' || action === 'end') {
    const cursor = screen.getCursorScreenPoint();
    if (Math.hypot(cursor.x - dragSession.cursor.x, cursor.y - dragSession.cursor.y) >= 4) dragSession.moved = true;
    positionOverlay();
  }
  if (action !== 'end' && action !== 'cancel') return;
  const moved = dragSession.moved;
  dragSession = null;
  if (action === 'end' && moved) {
    const target = overlay.getBounds();
    const anchor = anchorPosition(lastHost || screen.getPrimaryDisplay().workArea, target, settings.value.placement);
    try { settings.update({ offsetX: target.x - anchor.x, offsetY: target.y - anchor.y }); }
    catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNKNOWN';
      overlay.webContents.send('statusbar:drag-error', `位置未能保存（${code}），已恢复原位置。`);
    }
    publish();
  }
  positionOverlay();
}

function positionOverlay() {
  if (!overlay || overlay.isDestroyed() || !overlayLoaded) return;
  const value = settings.value;
  const bounds = lastHost || screen.getPrimaryDisplay().workArea;
  const display = screen.getDisplayMatching(bounds);
  let work = display.workArea;
  const availableWidth = Math.min(Math.max(280, bounds.width - 24), work.width);
  let width = Math.min(overlaySize.width, availableWidth);
  const compact = availableWidth / value.scale < 470;
  if (compactLayout?.compact !== compact || compactLayout?.availableWidth !== availableWidth || compactLayout?.availableHeight !== work.height) {
    compactLayout = { compact, availableWidth, availableHeight: work.height };
    overlay.webContents.send('statusbar:compact', compactLayout);
  }
  let height = Math.min(overlaySize.height, work.height);
  const anchor = anchorPosition(bounds, { width, height }, value.placement);
  let x = anchor.x + value.offsetX;
  let y = anchor.y + value.offsetY;
  if (dragSession?.moved) {
    const cursor = screen.getCursorScreenPoint();
    work = screen.getDisplayNearestPoint(cursor).workArea;
    width = Math.min(dragSession.bounds.width, work.width);
    height = Math.min(dragSession.bounds.height, work.height);
    x = dragSession.bounds.x + cursor.x - dragSession.cursor.x;
    y = dragSession.bounds.y + cursor.y - dragSession.cursor.y;
  } else {
    work = screen.getDisplayMatching({ x: Math.round(x), y: Math.round(y), width, height }).workArea;
  }
  x = Math.max(work.x, Math.min(x, work.x + work.width - width));
  y = Math.max(work.y, Math.min(y, work.y + work.height - height));
  const next = { x: Math.round(x), y: Math.round(y), width: Math.ceil(width), height: Math.ceil(height) };
  const current = overlay.getBounds();
  if (Object.keys(next).some(key => next[key] !== current[key])) overlay.setBounds(next);
  const visible = !manuallyHidden && (smoke || demo || value.alwaysVisible || hostVisible || Boolean(ownForeground && settingsWindow?.isFocused()));
  const currentVisible = overlay.isVisible();
  if (visible && !currentVisible) overlay.showInactive();
  if (!visible && currentVisible) {
    dragSession = null;
    overlay.hide();
    overlay.webContents.send('statusbar:collapse');
  }
  if (visible !== currentVisible) queuePublish();
}

function restorePosition() {
  settings.update({ placement: 'top-right', offsetX: 0, offsetY: 0 });
  manuallyHidden = false;
  publish();
  positionOverlay();
  overlay.showInactive();
}

function watchWindows() {
  if (process.platform !== 'win32' || smoke || demo) return;
  const script = app.isPackaged ? path.join(process.resourcesPath, 'window-watch.ps1') : path.join(__dirname, '..', 'scripts', 'window-watch.ps1');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  nativeWatcher = spawn(executable, ['-MTA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-OverlayProcessId', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const watcher = nativeWatcher;
  watcherStartedAt = Date.now();
  watcherLastSampleAt = 0;
  let pending = '';
  watcher.stdout.setEncoding('utf8');
  watcher.stdout.on('data', data => {
    pending += data;
    const lines = pending.split('\n');
    pending = lines.pop();
    if (pending.length > 16384) pending = '';
    for (const line of lines) {
      let sample;
      try { sample = JSON.parse(line); } catch { continue; }
      watcherLastSampleAt = Date.now();
      watcherError = null;
      navigation?.setHost(sample.processId, sample.windowCount);
      if (sample.visible) visibleChat?.observe(sample.documentTitle, sample.processId, sample.handle);
      queuePublish();
      ownForeground = sample.ownForeground === true;
      if (ownForeground) { positionOverlay(); continue; }
      const previousHostVisible = hostVisible;
      hostVisible = sample.visible === true;
      if (hostVisible && [sample.x, sample.y, sample.width, sample.height].every(Number.isFinite)) {
        const physical = { x: sample.x, y: sample.y, width: sample.width, height: sample.height };
        lastHost = screen.screenToDipRect(null, physical);
      }
      positionOverlay();
      if (hostVisible !== previousHostVisible) queuePublish();
    }
  });
  watcher.stderr.on('data', () => { watcherError = '窗口跟随助手报告错误'; queuePublish(); });
  watcher.on('error', error => { watcherError = `窗口跟随助手启动失败（${/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'UNKNOWN'}）`; queuePublish(); });
  watcher.on('close', () => {
    if (nativeWatcher !== watcher) return;
    nativeWatcher = null;
    ownForeground = false;
    visibleChat?.observe(null, 0, 0);
    hostVisible = false;
    positionOverlay();
    queuePublish();
    if (!quitting) geometryTimer = setTimeout(watchWindows, 2000);
  });
}

function checkWatcher() {
  if (!nativeWatcher || quitting) return;
  if (Date.now() - (watcherLastSampleAt || watcherStartedAt) < 7000) return;
  watcherError = '窗口跟随助手超过 7 秒无响应，正在重启';
  nativeWatcher.kill();
  queuePublish();
}

function createOverlay() {
  overlay = new BrowserWindow({
    title: 'Codex Token 状态条', width: overlaySize.width, height: overlaySize.height,
    transparent: true, frame: false, show: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, minimizable: false, maximizable: false, focusable: false,
    hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: !smoke },
  });
  overlay.setIgnoreMouseEvents(false);
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.on('will-navigate', event => event.preventDefault());
  overlay.webContents.once('did-finish-load', () => { overlayLoaded = true; publish(); positionOverlay(); });
  overlay.loadFile(path.join(__dirname, 'ui', 'index.html'));
  overlay.on('close', event => { if (!quitting) { event.preventDefault(); manuallyHidden = true; overlay.hide(); } });
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    title: 'Codex Token 状态条设置', width: 560, height: 720, minWidth: 460, minHeight: 500,
    autoHideMenuBar: true, backgroundColor: latest?.dark ? '#13161e' : '#f5f6f8',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: !smoke },
  });
  settingsWindow.setMenu(null);
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
  settingsWindow.loadFile(path.join(__dirname, 'ui', 'settings.html'));
  settingsWindow.on('focus', positionOverlay);
  settingsWindow.on('blur', positionOverlay);
  settingsWindow.on('closed', () => { settingsWindow = null; positionOverlay(); });
}

function buildTray() {
  // A tiny local bitmap avoids any external image or runtime network dependency.
  const bytes = Buffer.alloc(20 * 20 * 4);
  for (let y = 2; y < 18; y++) for (let x = 2; x < 18; x++) {
    const offset = (y * 20 + x) * 4;
    const lit = x === 3 || x === 16 || y === 3 || y === 16 || x >= 7 && x <= 12 && y >= 7 && y <= 12;
    if (lit) { bytes[offset] = 142; bytes[offset + 1] = 207; bytes[offset + 2] = 62; bytes[offset + 3] = 255; }
  }
  tray = new Tray(nativeImage.createFromBitmap(bytes, { width: 20, height: 20 }));
  const menu = () => Menu.buildFromTemplate([
    { label: 'Codex Token 状态条', enabled: false },
    { label: manuallyHidden ? '显示浮条' : '隐藏浮条', click: () => { manuallyHidden = !manuallyHidden; positionOverlay(); } },
    { label: '设置与聊天选择…', click: openSettings },
    { label: '恢复浮条位置', click: restorePosition },
    { label: '刷新本地数据', click: () => { ipc.refreshBinding(); store.scan(); } },
    { type: 'separator' },
    { label: '跟随当前聊天', type: 'checkbox', checked: !settings.value.pinnedThreadId, click: () => { settings.update({ pinnedThreadId: null }); publish(); } },
    { label: '始终显示', type: 'checkbox', checked: settings.value.alwaysVisible, click: item => { settings.update({ alwaysVisible: item.checked }); publish(); positionOverlay(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
  tray.on('click', () => { manuallyHidden = !manuallyHidden; positionOverlay(); });
  tray.on('double-click', openSettings);
}

function demoState() {
  return {
    settings: { ...settings.value, showTurn: true, showToday: true }, dark: true,
    selection: { mode: 'following', connected: true, threadId: '00000000-0000-0000-0000-000000000001', routeCount: 1, title: 'Codex Token 状态条 · 演示聊天', source: 'desktop-navigation' },
    health: { fileCount: 6, sessionCount: 4, indexing: false, truncated: false, readErrors: 0 },
    session: {
      threadId: '00000000-0000-0000-0000-000000000001', model: 'Codex', hasUsage: true, active: false, updatedAt: new Date().toISOString(),
      totals: { input_tokens: 1820000, cached_input_tokens: 1430000, output_tokens: 24000, reasoning_output_tokens: 8500, total_tokens: 1844000 },
      context: { used: 114400, capacity: 258400, percent: 44.2724, ...contextStatus(44.2724, 258400), exceeded: false }, cacheHitPercent: 78.57,
      toolUsage: { total: 17, failed: 1, durationMs: 14000, timed: 12, byType: [{ type: 'CommandExecution', label: '命令执行', total: 11, failed: 1, durationMs: 11000, timed: 9 }, { type: 'FileChange', label: '文件修改', total: 6, failed: 0, durationMs: 3000, timed: 3 }] },
      turnToolUsage: { total: 3, failed: 1, durationMs: 2800, timed: 2, byType: [{ type: 'CommandExecution', label: '命令执行', total: 2, failed: 1, durationMs: 2800, timed: 2 }, { type: 'FileChange', label: '文件修改', total: 1, failed: 0, durationMs: 0, timed: 0 }] }, turnRequests: 2,
      turnTokens: { input_tokens: 85000, output_tokens: 1420, total_tokens: 86420 }, turnCount: 12,
      lastTurn: { speed: { tokensPerSecond: 28.4, excludesFirstToken: true, includesToolTime: true }, durationMs: 52000, firstTokenMs: 2000, tokens: { output_tokens: 1420, total_tokens: 86420 }, status: 'completed', completedAt: new Date().toISOString() },
    },
    today: { day: new Date().toLocaleDateString('sv-SE'), usage: { total_tokens: 6280000 }, partial: false }, sessions: [],
    runtime: { version: displayVersion, watcherRunning: true, watcherHealthy: true, watcherLastSampleAt: Date.now(), watcherError: null, codexForeground: true, overlayVisible: true, manuallyHidden: false, testMode: true },
  };
}

async function smokeCheck() {
  await new Promise(resolve => setTimeout(resolve, 2500));
  fs.mkdirSync(artifactDirectory, { recursive: true });
  // Screenshots always use synthetic fixtures, even though the data probe is real.
  previewFixture = true;
  overlay.webContents.send('statusbar:snapshot', demoState());
  overlay.showInactive();
  await new Promise(resolve => setTimeout(resolve, 500));
  const bar = await overlay.webContents.capturePage();
  fs.writeFileSync(path.join(artifactDirectory, 'statusbar.png'), bar.toPNG());
  await overlay.webContents.executeJavaScript("document.querySelector('[data-action=details]').click()");
  await new Promise(resolve => setTimeout(resolve, 500));
  const expanded = await overlay.webContents.capturePage();
  fs.writeFileSync(path.join(artifactDirectory, 'details.png'), expanded.toPNG());
  openSettings();
  await new Promise(resolve => settingsWindow.webContents.once('did-finish-load', resolve));
  settingsWindow.webContents.send('statusbar:snapshot', demoState());
  await new Promise(resolve => setTimeout(resolve, 2000));
  const settingsLayout = await settingsWindow.webContents.executeJavaScript(`({ ready: document.readyState, text: document.body.innerText, controls: document.querySelectorAll('[data-setting]').length, connection: document.getElementById('connection').textContent, diagnosticVersion: document.getElementById('diag-version').textContent })`);
  if (settingsLayout.ready !== 'complete' || settingsLayout.controls !== 17 || !settingsLayout.connection.includes('已连接') || settingsLayout.diagnosticVersion !== displayVersion) throw new Error('Settings did not render correctly');
  fs.writeFileSync(path.join(artifactDirectory, 'settings.png'), (await settingsWindow.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  const settingsScroll = [];
  const settingsTypography = [];
  for (const size of [{ width: 560, height: 720 }, { width: 460, height: 500 }]) {
    settingsWindow.setSize(size.width, size.height);
    settingsWindow.focus();
    settingsWindow.webContents.focus();
    await settingsWindow.webContents.executeJavaScript('window.scrollTo(0, 0); document.activeElement.blur()');
    await new Promise(resolve => setTimeout(resolve, 200));
    settingsWindow.webContents.sendInputEvent({ type: 'mouseWheel', x: 80, y: 80, deltaY: -550, deltaX: 0, canScroll: true });
    await new Promise(resolve => setTimeout(resolve, 400));
    const wheel = await settingsWindow.webContents.executeJavaScript('window.scrollY');
    settingsWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: ['control'] });
    settingsWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: ['control'] });
    await new Promise(resolve => setTimeout(resolve, 400));
    const bottom = await settingsWindow.webContents.executeJavaScript(`({ scrollTop: window.scrollY, scrollHeight: document.scrollingElement.scrollHeight, clientHeight: document.scrollingElement.clientHeight, actionsVisible: document.getElementById('quit').getBoundingClientRect().bottom <= innerHeight && document.getElementById('quit').getBoundingClientRect().top >= 0 })`);
    settingsScroll.push({ size, wheel, ...bottom });
    if (wheel <= 0 || !bottom.actionsVisible || bottom.scrollHeight - bottom.clientHeight - bottom.scrollTop > 2) throw new Error('Settings scrolling failed: ' + JSON.stringify(settingsScroll.at(-1)));
    const typography = await settingsWindow.webContents.executeJavaScript(`(() => {
      const status = document.getElementById('diag-window');
      const original = status.textContent;
      status.textContent = '助手正常，Codex 不在前台或已最小化；切回窗口后自动跟随';
      const rows = [...document.querySelectorAll('.diagnostic-rows > div')];
      const values = rows.map(row => row.querySelector('strong').getBoundingClientRect());
      const fits = rows.every(row => {
        const label = row.querySelector('span').getBoundingClientRect();
        const value = row.querySelector('strong').getBoundingClientRect();
        return label.height < 28 && value.left >= label.right + 10 && value.right <= row.getBoundingClientRect().right + 1 && row.scrollWidth <= row.clientWidth + 1;
      });
      const result = { fits, valuesAligned: values.every(value => Math.abs(value.left - values[0].left) < 1), pageFits: document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth, longStatusLines: status.getBoundingClientRect().height / parseFloat(getComputedStyle(status).lineHeight) };
      status.textContent = original;
      return result;
    })()`);
    settingsTypography.push({ size, ...typography });
    if (!typography.fits || !typography.valuesAligned || !typography.pageFits) throw new Error('Settings text overlaps or overflows: ' + JSON.stringify(settingsTypography.at(-1)));
    fs.writeFileSync(path.join(artifactDirectory, 'settings-bottom-' + size.width + '.png'), (await settingsWindow.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  }
  fs.writeFileSync(path.join(artifactDirectory, 'settings-bottom.png'), (await settingsWindow.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  const previousSettings = { ...settings.value };
  await settingsWindow.webContents.executeJavaScript(`const input = document.getElementById('offsetX'); input.value = '40'; input.dispatchEvent(new Event('change', { bubbles: true }));`);
  await settingsWindow.webContents.executeJavaScript("const toggle = document.querySelector('[data-setting=hideLabels]'); if (!toggle.checked) toggle.click();");
  await new Promise(resolve => setTimeout(resolve, 300));
  const savedStatus = await settingsWindow.webContents.executeJavaScript("document.getElementById('save-status').textContent");
  const reloadedSettings = new SettingsStore(app.getPath('userData'));
  if (savedStatus || settings.value.offsetX !== 40 || reloadedSettings.value.offsetX !== 40) throw new Error('Settings UI did not persist the change: ' + savedStatus);
  const hiddenText = await overlay.webContents.executeJavaScript(`({ labelsHidden: [...document.querySelectorAll('.statusbar .k, .statusbar .route')].every(element => getComputedStyle(element).display === 'none'), valuesVisible: document.getElementById('speed').getBoundingClientRect().width > 0 && document.getElementById('speed').textContent.includes('28.4'), buttonsVisible: document.querySelector('[data-action=details]').getBoundingClientRect().width > 0 && document.querySelector('[data-action=settings]').getBoundingClientRect().width > 0, detailsReadable: document.getElementById('details').innerText.includes('输入 Token') && document.getElementById('tools-detail').innerText.includes('17 次') })`);
  if (!reloadedSettings.value.hideLabels || Object.values(hiddenText).some(value => !value)) throw new Error('Hidden text setting failed: ' + JSON.stringify(hiddenText));
  const longDetails = demoState();
  longDetails.selection.title = '验证隐藏文字及窄窗口下的长聊天标题显示，明细标题应自动换行且不会遮挡统计内容。'.repeat(3);
  longDetails.settings.hideLabels = true;
  longDetails.session.turnToolUsage = { total: 45, failed: 0, timed: 30, durationMs: 111600, byType: [{ type: 'CommandExecution', label: '命令执行', total: 45, failed: 0, timed: 30, durationMs: 111600 }] };
  longDetails.session.toolUsage = { total: 211, failed: 16, timed: 151, durationMs: 499000, byType: [{ type: 'CommandExecution', label: '命令执行', total: 211, failed: 16, timed: 151, durationMs: 499000 }] };
  overlay.webContents.send('statusbar:snapshot', longDetails);
  await new Promise(resolve => setTimeout(resolve, 400));
  const longDetailLayout = await overlay.webContents.executeJavaScript(`(() => { const panel = document.getElementById('details'); const label = document.getElementById('turn-tools-label'); const row = label.parentElement; const title = document.getElementById('chat-title'); return { labelWidth: label.getBoundingClientRect().width, labelHeight: label.getBoundingClientRect().height, valueWidth: document.getElementById('turn-tools-detail').getBoundingClientRect().width, rowHeight: row.getBoundingClientRect().height, shellFits: document.getElementById('shell').getBoundingClientRect().height <= document.documentElement.clientHeight + 2, titleFits: !title.hidden && title.scrollWidth <= title.clientWidth + 1 && panel.scrollWidth <= panel.clientWidth + 1, panelScrollable: panel.scrollHeight > panel.clientHeight }; })()`);
  if (longDetailLayout.labelWidth < 70 || longDetailLayout.labelHeight > 40 || !longDetailLayout.shellFits || !longDetailLayout.titleFits) throw new Error('Long details do not fit with hidden bar labels: ' + JSON.stringify(longDetailLayout));
  fs.writeFileSync(path.join(artifactDirectory, 'hidden-details.png'), (await overlay.webContents.capturePage()).toPNG());
  const loaded = new Promise(resolve => settingsWindow.webContents.once('did-finish-load', resolve));
  settingsWindow.webContents.reload();
  await loaded;
  await new Promise(resolve => setTimeout(resolve, 300));
  const restoredControl = await settingsWindow.webContents.executeJavaScript("document.getElementById('offsetX').value");
  if (restoredControl !== '40') throw new Error('Settings UI did not restore the saved value');
  if (!await settingsWindow.webContents.executeJavaScript("document.querySelector('[data-setting=hideLabels]').checked")) throw new Error('Hidden text checkbox did not restore');
  settings.update(previousSettings);
  publish();
  await new Promise(resolve => setTimeout(resolve, 300));
  const layout = await overlay.webContents.executeJavaScript(`({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, overflow: document.querySelector('.zu-main').scrollWidth > document.querySelector('.zu-main').clientWidth, bodyText: document.body.innerText, panels: document.querySelectorAll('.panel.open').length })`);
  if (layout.overflow || !layout.bodyText.includes('28.4') || layout.panels !== 1) throw new Error('Statusbar did not render correctly');
  const previousHost = lastHost;
  settings.update({ showSpeed: true, showContext: true, showSession: true, showTurn: true, showToday: true, showCache: true, showTools: true, scale: 1.5 });
  publish();
  lastHost = { ...screen.getPrimaryDisplay().workArea, width: 350 };
  positionOverlay();
  await new Promise(resolve => setTimeout(resolve, 600));
  const narrow = await overlay.webContents.executeJavaScript(`({ compact: document.getElementById('shell').classList.contains('compact'), hidden: document.querySelectorAll('.metric.overflowed').length, more: document.getElementById('more-count').textContent, barFits: document.getElementById('bar').scrollWidth <= document.getElementById('bar').clientWidth + 1, metricsFit: document.getElementById('metrics').scrollWidth <= document.getElementById('metrics').clientWidth + 1, detailsList: document.getElementById('overflow-list').children.length })`);
  settings.update(previousSettings);
  publish();
  lastHost = previousHost;
  positionOverlay();
  await new Promise(resolve => setTimeout(resolve, 300));
  const expandedAgain = await overlay.webContents.executeJavaScript("!document.getElementById('shell').classList.contains('compact') && getComputedStyle(document.querySelector('.statusbar .k')).display !== 'none'");
  if (!narrow.compact || narrow.hidden < 1 || !narrow.barFits || !narrow.metricsFit || narrow.detailsList !== narrow.hidden || !expandedAgain) throw new Error('Window resizing did not preserve all metric access: ' + JSON.stringify(narrow));
  const interactions = process.argv.includes('--smoke-no-mouse') ? { skipped: true } : await require('./smoke-interactions.cjs').checkInteractions({ overlay, settingsWindow, settings, publish, positionOverlay, artifactDirectory });
  const report = { layout, settingsLayout, settingsScroll, settingsTypography, hiddenText, longDetailLayout, interactions, settingsPersistence: { uiChangeSaved: true, freshStoreRestored: true, reloadedControlRestored: true }, responsiveLabels: narrow.compact && expandedAgain, narrowOverflow: narrow, health: latest.health, ipcConnected: ipc.connected, selectionMode: latest.selection.mode, hasUsage: latest.session?.hasUsage ?? false };
  fs.writeFileSync(path.join(artifactDirectory, 'smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ smoke: 'passed', health: report.health, ipcConnected: report.ipcConnected, selectionMode: report.selectionMode, overflow: layout.overflow }));
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_, args) => {
    if (args.includes('--quit')) { app.quit(); return; }
    if (args.includes('--autostart')) return;
    manuallyHidden = false;
    positionOverlay();
    openSettings();
  });
  app.whenReady().then(async () => {
    settings = new SettingsStore(app.getPath('userData'));
    store = new SessionStore();
    ipc = new CodexIpc();
    // No remote resources are required by this application.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_, callback) => callback({ cancel: true }));
    createOverlay();
    if (!smoke && !demo) buildTray();
    ipcMain.on('statusbar:ready', event => { if (validSender(event)) { if (demo) event.sender.send('statusbar:snapshot', demoState()); else publish(); } });
    ipcMain.on('statusbar:resize', (event, size) => {
      if (event.sender !== overlay.webContents || !Number.isFinite(size?.width) || !Number.isFinite(size?.height)) return;
      overlaySize = { width: Math.max(260, Math.min(1400, Math.ceil(size.width))), height: Math.max(48, Math.min(1600, Math.ceil(size.height))) };
      positionOverlay();
    });
    ipcMain.on('statusbar:drag', (event, action, point) => { if (event.sender === overlay.webContents && ['start', 'move', 'end', 'cancel'].includes(action)) dragOverlay(action, point); });
    ipcMain.on('statusbar:open-settings', event => { if (validSender(event)) openSettings(); });
    ipcMain.on('statusbar:restore-position', event => { if (validSender(event)) restorePosition(); });
    ipcMain.on('statusbar:refresh', event => { if (validSender(event)) { ipc.refreshBinding(); store.scan(); } });
    ipcMain.on('statusbar:quit', event => { if (validSender(event)) app.quit(); });
    ipcMain.handle('statusbar:settings', (event, patch) => {
      if (!validSender(event)) throw new Error('Invalid sender');
      let value;
      try { value = settings.update(patch); }
      catch (error) {
        const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNKNOWN';
        const message = code === 'ENOSPC' ? '磁盘空间不足，设置未保存。' : ['EACCES', 'EPERM'].includes(code) ? `设置文件无法写入（${code}），请检查目录权限或安全软件拦截。` : `设置未能保存（${code}），请稍后重试。`;
        return { ok: false, error: { code, message } };
      }
      publish();
      positionOverlay();
      return { ok: true, value };
    });
    store.on('updated', queuePublish);
    ipc.on('status', queuePublish);
    nativeTheme.on('updated', queuePublish);
    screen.on('display-metrics-changed', positionOverlay);
    screen.on('display-removed', positionOverlay);
    ipc.start();
    if (!smoke && !demo) {
      navigation = new DesktopNavigation();
      visibleChat = new VisibleChat(store.home);
      navigation.on('status', queuePublish);
      visibleChat.on('status', queuePublish);
      navigation.start();
      visibleChat.start();
    }
    await store.start();
    publish();
    watchWindows();
    if (!smoke && !demo) watcherWatchdog = setInterval(checkWatcher, 2000);
    if (demo) overlay.webContents.once('did-finish-load', () => overlay.webContents.send('statusbar:snapshot', demoState()));
    if (smoke) smokeCheck().catch(error => { console.error(error.stack ?? error.message); app.exit(1); });
  }).catch(error => { console.error(error.stack ?? error.message); app.exit(1); });
}
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  clearTimeout(publishTimer);
  clearTimeout(geometryTimer);
  clearInterval(watcherWatchdog);
  ipc?.stop();
  navigation?.stop();
  visibleChat?.stop();
  store?.stop();
  nativeWatcher?.kill();
  tray?.destroy();
});
