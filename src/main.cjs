'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage, nativeTheme, screen, session, clipboard, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { WindowWatcher } = require('./window-watcher.cjs');
const { SessionStore } = require('./session-store.cjs');
const { CodexIpc } = require('./codex-ipc.cjs');
const { readCodexQuota } = require('./codex-quota.cjs');
const { DesktopNavigation } = require('./desktop-navigation.cjs');
const { VisibleChat, resolveVisibleSelection } = require('./visible-chat.cjs');
const { SettingsStore } = require('./settings.cjs');
const { contextStatus } = require('./metrics.cjs');
const { requestPage } = require('./response-usage.cjs');
const { anchorPosition, displayPosition, positionPatch, clampBounds } = require('./display-position.cjs');
const { diagnosticSummary, diagnosticState, newerVersion, versionParts, RELEASE_URL, UPDATE_URL } = require('./diagnostics.cjs');
const { OverlayLayer } = require('./overlay-layer.cjs');
const { composerPosition, titlebarPosition } = require('./composer-position.cjs');
const overlayLayer = new OverlayLayer();

app.setName('Codex Token Statusbar');
const packageInfo = require('../package.json');
const displayVersion = packageInfo.displayVersion ?? app.getVersion();
const appIconFile = path.join(__dirname, '..', `${packageInfo.appIcon}.png`);
const appIconName = path.basename(packageInfo.appIcon);
const settingsLinks = new Set([
  'https://space.bilibili.com/14642527?spm_id_from=333.1007.0.0',
  'https://github.com/3ALLBUY14/codex-token-statusbar',
]);
const smoke = process.argv.includes('--smoke');
const demo = process.argv.includes('--demo');
const nativeUpdates = process.platform === 'win32' && !smoke && !demo;
const updateActivation = 'type=click&view=updates';
// Windows starts the registered notification activator with -Embedding.
const isNotificationLaunch = args => nativeUpdates && args.some(arg => arg.toLowerCase() === '-embedding');
if (nativeUpdates) {
  app.setAppUserModelId('io.github.3ALLBUY14.CodexTokenStatusbar');
  app.setToastActivatorCLSID('{AEFF8848-6C82-4123-8D2A-E15979826C83}');
}
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
let previewFixture = false;
let fixtureOverride = null;
let fixtureRequests = null;
let compactLayout = null;
let dragSession = null;
let watcherLastSampleAt = 0;
let watcherError = null;
let watcherWatchdog;
let settingsWantsTools = false;
let catalogCache = null;
let catalogSignature = '';
let updateSession, updateTimer, updateRequest;
let updateResult = null, lastNotifiedRelease = null;
let updateNotification = null, updateNotificationPending = false;
let lastUpdateActivation = -Infinity;
let settingsCaptionDark;
const updateInterval = 24 * 60 * 60 * 1000;
const quotaInterval = 5 * 60 * 1000;
let officialQuota = null, quotaStatus = null, quotaTimer, quotaRequest;
let composerSample = null, hostHandle = 0, dockStatus = 'off';
let deliverySequence = 0, deliveryEpoch = 0, deliverySelection = null;
function previewOpacity(value) {
  const opacity = Number.isFinite(value) ? Math.max(0.2, Math.min(1, value)) : null;
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('statusbar:opacity-preview', opacity);
}

function updateActivity() {
  const active = hostVisible || Boolean(settingsWindow?.isVisible());
  store?.setActive(active);
  navigation?.setActive(active);
  visibleChat?.setActive(active);
}

function runtimeStatus() {
  const watcherState = nativeWatcher?.status();
  const watcherRunning = watcherState?.geometryRunning ?? false;
  return {
    version: displayVersion,
    watcherRunning,
    watcherHealthy: watcherState?.geometryHealthy ?? false,
    watcherBackend: watcherState?.backend ?? null,
    titleHealthy: watcherState?.titleHealthy ?? false,
    titleError: watcherState?.titleError ?? null,
    indexError: visibleChat?.indexError ?? null,
    indexCached: Boolean(visibleChat?.indexError && visibleChat?.indexed),
    displayCount: screen.getAllDisplays().length,
    displayScale: currentDisplay().scaleFactor,
    watcherLastSampleAt: watcherLastSampleAt || null,
    watcherError,
    codexForeground: hostVisible,
    overlayVisible: Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible()),
    manuallyHidden,
    desktopCompatibility: settings.value.desktopCompatibility,
    overlayTopmost: Boolean(overlay && !overlay.isDestroyed() && overlay.isAlwaysOnTop()),
    composerDock: dockStatus,
    testMode: smoke || demo,
  };
}

const validSender = event => [overlay, settingsWindow].some(win => win && !win.isDestroyed() && win.webContents === event.sender);
function settingsFailure(error) {
  const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNKNOWN';
  const message = code === 'ENOSPC' ? '磁盘空间不足，设置未保存。' : ['EACCES', 'EPERM'].includes(code) ? `设置文件无法写入（${code}），请检查目录权限或安全软件拦截。` : `设置未能保存（${code}），请稍后重试。`;
  return { ok: false, error: { code, message } };
}

async function fetchRelease() {
  if (smoke) return { ok: true, tag: 'V99.0', newer: true };
  try {
    const response = await updateSession.fetch(UPDATE_URL, {
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CodexTokenStatusbar' },
    });
    if (!response.ok) throw new Error('update-http-error');
    const body = await response.text();
    if (body.length > 256000) throw new Error('update-response-limit');
    const release = JSON.parse(body);
    if (typeof release.tag_name !== 'string' || !versionParts(release.tag_name) || release.draft || release.prerelease) throw new Error('update-invalid-release');
    return { ok: true, tag: release.tag_name, newer: newerVersion(release.tag_name, displayVersion) };
  } catch {
    return { ok: false, message: '暂时无法检查更新，可直接打开 GitHub 发布页。' };
  }
}

function openUpdateNotification() {
  const now = performance.now();
  // Windows can deliver both an activation callback and an instance click.
  if (quitting || now - lastUpdateActivation < 250) return;
  lastUpdateActivation = now;
  openSettings('updates');
}

function showUpdateNotification(tag) {
  if (updateNotificationPending || !Notification.isSupported()) return;
  const notification = new Notification({
    id: 'CodexReleaseUpdate',
    toastXml: `<toast launch="${updateActivation.replace('&', '&amp;')}">
      <visual><binding template="ToastGeneric">
        <text>状态条有新版 ${tag}</text>
        <text>点击查看版本更新。</text>
      </binding></visual>
      <audio silent="true"/>
    </toast>`,
  });
  updateNotification = notification;
  updateNotificationPending = true;
  notification.once('click', openUpdateNotification);
  notification.once('show', () => {
    updateNotificationPending = false;
    lastNotifiedRelease = tag;
    try { settings.update({ lastNotifiedRelease }); } catch { /* Keep the reminder deduplicated in memory. */ }
  });
  notification.once('failed', () => {
    if (updateNotification !== notification) return;
    updateNotification = null;
    updateNotificationPending = false;
  });
  try { notification.show(); }
  catch {
    updateNotification = null;
    updateNotificationPending = false;
  }
}

async function checkUpdates(background = false) {
  if (!updateRequest) {
    updateRequest = fetchRelease().then(result => {
      if (result.ok || !updateResult?.ok) updateResult = result;
      return result;
    }).finally(() => {
      updateRequest = null;
      queuePublish();
    });
    queuePublish();
  }
  const result = await updateRequest;
  if (background && !quitting && result.newer && nativeUpdates && settings.value.updateMode === 'popup'
      && (!lastNotifiedRelease || newerVersion(result.tag, lastNotifiedRelease))) {
    showUpdateNotification(result.tag);
  }
  return result;
}

function scheduleUpdateCheck(delay = 5000) {
  clearTimeout(updateTimer);
  if (quitting || smoke || demo || settings.value.updateMode === 'manual') return;
  // Let Electron register the Windows notification identity before the first check.
  if (nativeUpdates && settings.value.updateMode === 'popup') Notification.isSupported();
  updateTimer = setTimeout(() => {
    scheduleUpdateCheck(updateInterval);
    void checkUpdates(true);
  }, delay);
}

async function refreshQuota() {
  if (quitting || smoke || demo || quotaRequest) return;
  clearTimeout(quotaTimer);
  const request = quotaRequest = new AbortController();
  quotaStatus = 'refreshing';
  queuePublish();
  const quota = await readCodexQuota(packageInfo.version, request.signal);
  quotaRequest = null;
  if (quitting) return;
  if (quota) officialQuota = quota;
  quotaStatus = quota ? null : 'unavailable';
  quotaTimer = setTimeout(refreshQuota, quotaInterval);
  queuePublish();
}

function refreshData() {
  ipc.refreshBinding();
  store.scan();
  void refreshQuota();
}

function publish() {
  if (!store || quitting) return;
  const route = navigation?.status();
  const selection = route ? { ...ipc.status(), ...resolveVisibleSelection(route, visibleChat.status(navigation.processId), Boolean(visibleChat.titleForId(route.threadId))) } : ipc.status();
  latest = store.snapshot(settings.value, selection, { includeRecords: Boolean(settingsWindow?.isVisible() && settingsWantsTools), includeSessions: Boolean(settingsWindow?.isVisible()) });
  latest.quota = { source: 'local', ...(officialQuota ?? latest.quota), status: quotaStatus };
  if (settingsWindow?.isVisible()) {
    const signature = `${store.revision}:${visibleChat?.stamp}`;
    if (catalogSignature !== signature || !catalogCache) {
      catalogCache = latest.sessions.map(item => ({ ...item, title: visibleChat?.titleForId(item.id) ?? null }));
      catalogSignature = signature;
    }
    latest.sessions = catalogCache;
  }
  latest.selection.title = visibleChat?.titleForId(latest.selection.threadId) ?? null;
  latest.settings = { ...settings.value, ...currentPositionSettings() };
  latest.runtime = runtimeStatus();
  if (process.argv.includes('--health-report')) {
    try {
      fs.mkdirSync(artifactDirectory, { recursive: true });
      fs.writeFileSync(path.join(artifactDirectory, 'running-health.json'), JSON.stringify({
        pid: process.pid, version: displayVersion, updatedAt: new Date().toISOString(), ipcConnected: ipc.connected,
        selected: Boolean(latest.selection.threadId), routeCount: ipc.routes.size,
        accountingMethod: latest.session?.accounting?.method ?? null, accountingPartial: Boolean(latest.session?.accounting?.partial),
        relatedThreads: latest.session?.accounting?.relatedThreads ?? 0,
        selectionSource: latest.selection.source, navigationKnown: navigation?.status().known ?? false,
        selectionMode: latest.selection.mode, hasUsage: latest.session?.hasUsage ?? false,
        pinned: Boolean(settings.value.pinnedThreadId),
        watcherRunning: latest.runtime.watcherRunning, watcherHealthy: latest.runtime.watcherHealthy,
        watcherBackend: latest.runtime.watcherBackend, titleHealthy: latest.runtime.titleHealthy,
        indexError: latest.runtime.indexError, cacheHits: latest.health.cacheHits, cacheError: latest.health.cacheError,
        displayCount: latest.runtime.displayCount, displayScale: latest.runtime.displayScale,
        overlayVisible: latest.runtime.overlayVisible, overlayTopmost: latest.runtime.overlayTopmost, composerDock: latest.runtime.composerDock,
        quotaSource: latest.quota.source, quotaStatus, quotaRecordedAt: latest.quota.recordedAt ?? null,
        quotaWindows: latest.quota.windows?.map(window => window.minutes) ?? [],
        toolsTotal: latest.session?.toolUsage?.total ?? 0, toolsRecords: latest.session?.toolUsage?.records?.length ?? 0,
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
  const displayState = fixtureOverride ? { ...fixtureOverride, settings: { ...settings.value, ...currentPositionSettings() } } : previewFixture || demo ? demoState() : latest;
  displayState.update = { ...updateResult, checking: Boolean(updateRequest) };
  const selectionKey = `${displayState.selection.mode}:${displayState.selection.threadId ?? ''}`;
  if (selectionKey !== deliverySelection) { deliverySelection = selectionKey; deliveryEpoch++; }
  displayState.delivery = { sequence: ++deliverySequence, epoch: deliveryEpoch, sentAt: Date.now() };
  displayState.diagnostic = diagnosticState(displayState);
  if (overlay && !overlay.isDestroyed() && (!overlayLoaded || overlay.isVisible() || settings.value.dockToComposer || demo)) {
    const session = displayState.session;
    const strip = stats => stats ? { ...stats, records: [] } : stats;
    const lightweight = session ? { ...session, toolUsage: strip(session.toolUsage), turnToolUsage: strip(session.turnToolUsage), lastTurn: session.lastTurn ? { ...session.lastTurn, toolUsage: strip(session.lastTurn.toolUsage) } : null, runningTools: [], turnRunningTools: [] } : null;
    overlay.webContents.send('statusbar:snapshot', { ...displayState, sessions: [], session: lightweight });
  }
  if (settingsWindow && !settingsWindow.isDestroyed() && (settingsWindow.isVisible() || smoke || demo)) {
    if (displayState.dark !== settingsCaptionDark) {
      settingsWindow.setTitleBarOverlay(settingsCaption(displayState.dark));
      settingsCaptionDark = displayState.dark;
    }
    settingsWindow.webContents.send('statusbar:snapshot', { ...displayState, appIconName });
  }
  if (tray) {
    const total = latest.session?.hasUsage ? latest.session.totals.total_tokens.toLocaleString('zh-CN') : '—';
    tray.setToolTip(`Codex Token 状态条\n会话 ${total} tokens\n上下文 ${latest.session?.context.percent?.toFixed(1) ?? '—'}%`);
  }
}
function queuePublish() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(publish, 100);
}

function currentDisplay() { return lastHost ? screen.getDisplayMatching(lastHost) : screen.getPrimaryDisplay(); }
function currentPositionSettings() {
  const position = displayPosition(settings.value, currentDisplay(), screen.getAllDisplays());
  return { placement: settings.value.dockToComposer ? settings.value.dockTarget === 'titlebar' ? 'top-right' : 'bottom-center' : position.placement, offsetX: position.offsetX, offsetY: position.offsetY };
}
function updatePositionSettings(patch) {
  if (!patch || typeof patch !== 'object') return settings.value;
  const host = currentDisplay(), position = displayPosition(settings.value, host, screen.getAllDisplays());
  const location = Object.fromEntries(['placement', 'offsetX', 'offsetY'].filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]]));
  if (!Object.keys(location).length) return settings.update(patch);
  // Clean renderer input before putting it into a display-specific profile.
  const clean = require('./settings.cjs').cleanSettings(location, { ...settings.value, ...currentPositionSettings() });
  const rest = Object.fromEntries(Object.entries(patch).filter(([key]) => !Object.hasOwn(location, key)));
  return settings.update({ ...rest, ...positionPatch(settings.value, host, position.display, Object.fromEntries(Object.keys(location).map(key => [key, clean[key]]))) });
}

function dragOverlay(action, point) {
  if (action === 'start') {
    if (!settings.value.allowDrag || settings.value.dockToComposer || !overlay.isVisible()) return;
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
    const host = currentDisplay(), destination = screen.getDisplayMatching(target), position = currentPositionSettings();
    const anchor = anchorPosition(!settings.value.rememberDisplayPositions || destination.id === host.id ? lastHost || host.workArea : destination.workArea, target, position.placement);
    try { settings.update(positionPatch(settings.value, host, destination, { placement: position.placement, offsetX: target.x - anchor.x, offsetY: target.y - anchor.y })); }
    catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNKNOWN';
      overlay.webContents.send('statusbar:drag-error', `位置未能保存（${code}），已恢复原位置。`);
    }
    publish();
  }
  positionOverlay();
}

function positionOverlay() {
  updateActivity();
  if (!overlay || overlay.isDestroyed() || !overlayLoaded) return;
  const value = settings.value;
  nativeWatcher?.setComposerTracking(value.dockToComposer, value.dockTarget);
  const titlebar = value.dockToComposer && value.dockTarget === 'titlebar';
  const host = currentDisplay(), position = displayPosition(value, host, screen.getAllDisplays());
  const display = position.display;
  const bounds = display.id === host.id ? lastHost || host.workArea : display.workArea;
  let work = titlebar ? host.bounds : display.workArea;
  const composer = value.dockToComposer && hostVisible && composerSample && (composerSample.target ?? 'composer') === value.dockTarget && Date.now() - composerSample.at < 3500 && composerSample.handle === hostHandle && lastHost && composerSample.host.width === lastHost.width && composerSample.host.height === lastHost.height ? {
    ...composerSample.rect, x: composerSample.rect.x + lastHost.x - composerSample.host.x, y: composerSample.rect.y + lastHost.y - composerSample.host.y,
  } : null;
  const hostWork = titlebar ? host.bounds : host.workArea;
  const dockHost = lastHost && { x: Math.max(lastHost.x, hostWork.x), y: Math.max(lastHost.y, hostWork.y), width: Math.min(lastHost.x + lastHost.width, hostWork.x + hostWork.width) - Math.max(lastHost.x, hostWork.x), height: Math.min(lastHost.y + lastHost.height, hostWork.y + hostWork.height) - Math.max(lastHost.y, hostWork.y) };
  const availableWidth = Math.min(Math.max(200, composer?.width ?? bounds.width - 24), work.width);
  let width = Math.min(overlaySize.width, availableWidth);
  const compact = availableWidth / value.scale < 470;
  const barHeight = overlaySize.barHeight ?? Math.ceil(52 * value.scale);
  const dock = composer && (titlebar ? titlebarPosition : composerPosition)(dockHost, composer, { width, height: Math.min(overlaySize.height, work.height) }, barHeight, value.composerAlignment);
  const availableHeight = dock ? titlebar ? dockHost.y + dockHost.height - dock.y : dock.y + dock.height - dockHost.y : work.height;
  const titlebarHeight = titlebar ? composer?.height ?? 32 : null;
  if (compactLayout?.compact !== compact || compactLayout?.availableWidth !== availableWidth || compactLayout?.availableHeight !== availableHeight || compactLayout?.titlebarHeight !== titlebarHeight) {
    compactLayout = { compact, availableWidth, availableHeight, titlebarHeight };
    overlay.webContents.send('statusbar:compact', compactLayout);
  }
  let height = Math.min(overlaySize.height, work.height);
  const anchor = anchorPosition(bounds, { width, height }, position.placement);
  let x = anchor.x + position.offsetX;
  let y = anchor.y + position.offsetY;
  const previousDockStatus = dockStatus;
  dockStatus = !value.dockToComposer ? 'off' : !hostVisible ? 'host-hidden' : dock ? dock.edge : 'waiting';
  if (dock) { ({ x, y, width, height } = dock); work = hostWork; }
  else if (dragSession?.moved && !value.dockToComposer) {
    const cursor = screen.getCursorScreenPoint();
    work = screen.getDisplayNearestPoint(cursor).workArea;
    width = Math.min(dragSession.bounds.width, work.width);
    height = Math.min(dragSession.bounds.height, work.height);
    x = dragSession.bounds.x + cursor.x - dragSession.cursor.x;
    y = dragSession.bounds.y + cursor.y - dragSession.cursor.y;
  } else if (!value.rememberDisplayPositions) {
    work = screen.getDisplayMatching({ x: Math.round(x), y: Math.round(y), width, height }).workArea;
  }
  const next = clampBounds({ x, y, width, height }, work);
  const current = overlay.getBounds();
  if (Object.keys(next).some(key => next[key] !== current[key])) overlay.setBounds(next);
  const visible = !manuallyHidden && (value.dockToComposer ? Boolean(dock && (hostVisible || ownForeground)) : smoke || demo || value.alwaysVisible || hostVisible || Boolean(ownForeground && settingsWindow?.isFocused()));
  const currentVisible = overlay.isVisible();
  if (visible && !currentVisible) overlay.showInactive();
  if (visible) maintainOverlayLayer(!currentVisible);
  if (!visible && currentVisible) {
    dragSession = null;
    overlay.hide();
    overlay.webContents.send('statusbar:collapse');
  }
  if (visible !== currentVisible || previousDockStatus !== dockStatus) queuePublish();
}

function maintainOverlayLayer(force = false) {
  overlayLayer.maintain(overlay, { enabled: settings.value.desktopCompatibility, suspended: Boolean(settingsWindow?.isFocused()), force });
}

function restorePosition() {
  settings.update({ placement: 'top-right', offsetX: 0, offsetY: 0, displayPositions: [], dockToComposer: false });
  manuallyHidden = false;
  publish();
  positionOverlay();
  overlay.showInactive();
}

function watchWindows() {
  if (process.platform !== 'win32' || smoke || demo) return;
  const script = app.isPackaged ? path.join(process.resourcesPath, 'window-watch.ps1') : path.join(__dirname, '..', 'scripts', 'window-watch.ps1');
  const executable = app.isPackaged ? path.join(process.resourcesPath, 'WindowHelper.exe') : path.join(__dirname, '..', 'artifacts', 'native-helper', 'WindowHelper.exe');
  const watcher = nativeWatcher = new WindowWatcher({ executable, script });
  watcherLastSampleAt = 0;
  watcher.on('sample', sample => {
      watcherLastSampleAt = Date.now();
      watcherError = null;
      navigation?.setHost(sample.processId, sample.windowCount);
      if (sample.visible && watcher.status().backend === 'powershell') visibleChat?.observe(sample.documentTitle, sample.processId, sample.handle);
      queuePublish();
      ownForeground = sample.ownForeground === true;
      if (ownForeground) { positionOverlay(); return; }
      const previousHostVisible = hostVisible;
      hostVisible = sample.visible === true;
      if (hostVisible && sample.handle !== hostHandle) composerSample = null;
      if (hostVisible) hostHandle = sample.handle;
      else composerSample = null;
      if (hostVisible && [sample.x, sample.y, sample.width, sample.height].every(Number.isFinite)) {
        const physical = { x: sample.x, y: sample.y, width: sample.width, height: sample.height };
        lastHost = screen.screenToDipRect(null, physical);
      }
      positionOverlay();
      if (hostVisible !== previousHostVisible) queuePublish();
  });
  watcher.on('composer', sample => {
    if (!hostVisible || sample.handle !== hostHandle) return;
    composerSample = sample.rect && lastHost ? { handle: sample.handle, target: sample.target, rect: screen.screenToDipRect(null, sample.rect), host: { ...lastHost }, at: Date.now() } : null;
    positionOverlay();
  });
  watcher.on('title', sample => { visibleChat?.observe(sample.documentTitle, sample.processId, sample.handle); queuePublish(); });
  watcher.on('status', () => { watcherError = watcher.status().error; queuePublish(); });
  watcher.on('reset', () => {
    ownForeground = false;
    visibleChat?.observe(null, 0, 0);
    hostVisible = false;
    composerSample = null; hostHandle = 0;
    positionOverlay();
    queuePublish();
  });
  watcher.start();
}

function checkWatcher() {
  if (!quitting) { nativeWatcher?.check(); positionOverlay(); }
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
  overlay.setAlwaysOnTop(true, settings.value.desktopCompatibility ? 'pop-up-menu' : 'floating');
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.on('will-navigate', event => event.preventDefault());
  overlay.webContents.once('did-finish-load', () => { overlayLoaded = true; publish(); positionOverlay(); });
  overlay.loadFile(path.join(__dirname, 'ui', 'index.html'));
  overlay.on('close', event => { if (!quitting) { event.preventDefault(); manuallyHidden = true; overlay.hide(); } });
}

function settingsCaption(dark) {
  return { height: 36, color: dark ? '#191c22' : '#ffffff', symbolColor: dark ? '#f1f3f7' : '#182230' };
}

function openSettings(pane) {
  const openPane = win => {
    if (win.isDestroyed()) return;
    if (pane === 'requests') win.webContents.send('statusbar:request-filters');
    if (pane === 'updates') win.webContents.send('statusbar:show-updates');
  };
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    const opened = settingsWindow;
    if (opened.isMinimized()) opened.restore();
    opened.show();
    opened.focus();
    if (opened.webContents.isLoadingMainFrame()) opened.webContents.once('did-finish-load', () => openPane(opened));
    else openPane(opened);
    return;
  }
  settingsCaptionDark = latest?.dark ?? nativeTheme.shouldUseDarkColors;
  settingsWindow = new BrowserWindow({
    title: 'Codex Token 状态条设置', width: 734, height: 650, minWidth: 460, minHeight: 500,
    show: false, titleBarStyle: 'hidden', titleBarOverlay: settingsCaption(settingsCaptionDark),
    icon: appIconFile, backgroundColor: settingsCaptionDark ? '#111318' : '#f6f7fa',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: !smoke },
  });
  settingsWindow.setMenu(null);
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
  settingsWindow.webContents.on('did-start-loading', () => previewOpacity(null));
  const opened = settingsWindow;
  opened.once('ready-to-show', () => {
    if (opened.isDestroyed()) return;
    opened.show();
    opened.focus();
    updateActivity();
    publish();
    openPane(opened);
  });
  settingsWindow.loadFile(path.join(__dirname, 'ui', 'settings.html'));
  settingsWindow.on('focus', positionOverlay);
  settingsWindow.on('blur', positionOverlay);
  settingsWindow.on('closed', () => { previewOpacity(null); settingsWindow = null; settingsWantsTools = false; positionOverlay(); });
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(appIconFile).resize({ width: 32, height: 32, quality: 'best' }));
  const menu = () => Menu.buildFromTemplate([
    { label: 'Codex Token 状态条', enabled: false },
    { label: manuallyHidden ? '显示浮条' : '隐藏浮条', click: () => { manuallyHidden = !manuallyHidden; positionOverlay(); } },
    { label: '设置与聊天选择…', click: openSettings },
    { label: updateResult?.newer ? `发现新版 ${updateResult.tag}…` : '版本更新…', click: () => openSettings('updates') },
    { label: '恢复浮条位置', click: restorePosition },
    { label: '刷新用量与额度', click: refreshData },
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
  const toolRecords = Array.from({ length: 17 }, (_, i) => ({
    sequence: i + 1, type: i < 11 ? 'CommandExecution' : 'FileChange', label: i < 11 ? '命令执行' : '文件修改',
    status: i === 5 ? 'failed' : 'completed', timestamp: '2026-10-05T08:00:00Z',
    durationMs: i < 9 ? i === 0 ? 3000 : 1000 : i >= 11 && i < 14 ? 1000 : null,
    exitCode: i < 11 ? i === 5 ? 1 : 0 : null,
  }));
  const turnRecords = [
    { sequence: 1, type: 'CommandExecution', label: '命令执行', status: 'failed', timestamp: '2026-10-05T08:00:00Z', durationMs: 2800, exitCode: 1 },
    { sequence: 2, type: 'CommandExecution', label: '命令执行', status: 'completed', timestamp: '2026-10-05T08:00:00Z', durationMs: 0, exitCode: 0 },
    { sequence: 3, type: 'FileChange', label: '文件修改', status: 'completed', timestamp: '2026-10-05T08:00:00Z', durationMs: null, exitCode: null },
  ];
  return {
    settings: { ...settings.value, ...currentPositionSettings() }, dark: true, appIconName,
    selection: { mode: 'following', connected: true, threadId: '00000000-0000-0000-0000-000000000001', routeCount: 1, title: 'Codex Token 状态条 · 演示聊天', source: 'desktop-navigation' },
    health: { fileCount: 6, sessionCount: 4, indexing: false, truncated: false, readErrors: 0 },
    quota: { source: 'sample', plan: 'plus', recordedAt: Date.now(), windows: [
      { minutes: 300, percent: 82, reset: Date.now() + 73 * 60 * 1000 },
      { minutes: 10080, percent: 25, reset: Date.now() + 4 * 86400000 },
    ] },
    session: {
      threadId: '00000000-0000-0000-0000-000000000001', model: 'Codex', hasUsage: true, active: false, updatedAt: new Date().toISOString(),
      totals: { input_tokens: 1820000, cached_input_tokens: 1430000, output_tokens: 24000, reasoning_output_tokens: 8500, total_tokens: 1844000 },
      context: { used: 114400, capacity: 258400, percent: 44.2724, ...contextStatus(44.2724, 258400), exceeded: false, parts: { uncached: 36400, cached: 75600, output: 1600, reasoning: 800 } }, cacheHitPercent: 78.57,
      toolUsage: { total: 17, failed: 1, durationMs: 14000, timed: 12, records: toolRecords, byType: [{ type: 'CommandExecution', label: '命令执行', total: 11, failed: 1, durationMs: 11000, timed: 9 }, { type: 'FileChange', label: '文件修改', total: 6, failed: 0, durationMs: 3000, timed: 3 }] },
      turnToolUsage: { total: 3, failed: 1, durationMs: 2800, timed: 2, records: turnRecords, byType: [{ type: 'CommandExecution', label: '命令执行', total: 2, failed: 1, durationMs: 2800, timed: 2 }, { type: 'FileChange', label: '文件修改', total: 1, failed: 0, durationMs: 0, timed: 0 }] }, turnRequests: 2,
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
  settings.update({ showTurn: true, showToday: true });
  previewFixture = true;
  overlay.webContents.send('statusbar:snapshot', demoState());
  overlay.showInactive();
  await new Promise(resolve => setTimeout(resolve, 500));
  const bar = await overlay.webContents.capturePage();
  fs.writeFileSync(path.join(artifactDirectory, 'statusbar.png'), bar.toPNG());
  await overlay.webContents.executeJavaScript("(() => {const b=document.querySelector('[data-action=details]');if(b.getAttribute('aria-expanded')!=='true')b.click();})()");
  await new Promise(resolve => setTimeout(resolve, 500));
  const expanded = await overlay.webContents.capturePage();
  fs.writeFileSync(path.join(artifactDirectory, 'details.png'), expanded.toPNG());
  openSettings();
  await new Promise(resolve => settingsWindow.webContents.once('did-finish-load', resolve));
  settingsWindow.webContents.send('statusbar:snapshot', demoState());
  await new Promise(resolve => setTimeout(resolve, 2000));
  const settingsLayout = await settingsWindow.webContents.executeJavaScript(`({ ready: document.readyState, text: document.body.innerText, controls: document.querySelectorAll('[data-setting]').length, connection: document.getElementById('connection').textContent, diagnosticVersion: document.getElementById('diag-version').textContent })`);
  if (settingsLayout.ready !== 'complete' || settingsLayout.controls !== 25 || !settingsLayout.connection.includes('已连接') || settingsLayout.diagnosticVersion !== displayVersion) throw new Error('Settings did not render correctly');
  const captionLayout = await settingsWindow.webContents.executeJavaScript(`(() => {
    const overlay = navigator.windowControlsOverlay;
    const caption = document.querySelector('.settings-caption');
    const icon = document.getElementById('settings-app-icon');
    return overlay?.visible && caption.offsetWidth <= overlay.getTitlebarAreaRect().width + 1 &&
      getComputedStyle(caption).appRegion === 'drag' && icon.complete && icon.naturalWidth > 0;
  })()`);
  if (!captionLayout) throw new Error('Settings caption or app icon did not render correctly');
  const opacityCheck = await require('./smoke-opacity.cjs').checkOpacity({ overlay, settingsWindow, settings, publish, artifactDirectory });
  const settingsUx = await require('./settings-ux-smoke.cjs').checkSettingsUx({ win: settingsWindow, overlay, settings, publish, artifactDirectory });
  const toolDetails = await settingsWindow.webContents.executeJavaScript(`(() => {
    document.getElementById('open-tool-details').click();
    const list = document.getElementById('settings-tool-records');
    const sessionCount = list.children.length;
    const scope = document.getElementById('tool-scope');
    scope.value = 'turn'; scope.dispatchEvent(new Event('change', { bubbles: true }));
    const turnCount = list.children.length;
    const failed = document.getElementById('tool-failed-only');
    failed.checked = true; failed.dispatchEvent(new Event('change', { bubbles: true }));
    const failedCount = list.children.length;
    const failedStatus = list.innerText.includes('退出码 1') && list.innerText.includes('失败');
    failed.checked = false; failed.dispatchEvent(new Event('change', { bubbles: true }));
    const unknownDuration = list.innerText.includes('未记录') && list.innerText.includes('0.0s');
    scope.value = 'session'; scope.dispatchEvent(new Event('change', { bubbles: true }));
    return { expanded: !document.getElementById('pane-tools').hidden && document.getElementById('tool-details').tagName === 'DIV', sessionCount, turnCount, failedCount, failedStatus, unknownDuration };
  })()`);
  if (!toolDetails.expanded || toolDetails.sessionCount !== 17 || toolDetails.turnCount !== 3 || toolDetails.failedCount !== 1 || !toolDetails.failedStatus || !toolDetails.unknownDuration) throw new Error('Settings tool details failed: ' + JSON.stringify(toolDetails));
  const emptyToolState = demoState();
  emptyToolState.selection = { ...emptyToolState.selection, mode: 'empty', threadId: null, title: null };
  emptyToolState.session = null;
  fixtureOverride = emptyToolState; publish();
  await new Promise(resolve => setTimeout(resolve, 200));
  let emptyState;
  for (let attempt = 0; attempt < 30; attempt++) {
    emptyState = await settingsWindow.webContents.executeJavaScript("({ records: document.getElementById('settings-tool-records').children.length, groups: document.getElementById('settings-tool-groups').children.length, emptyLabel: document.getElementById('tool-chat').textContent.includes('暂无聊天') })");
    if (emptyState.records === 0 && emptyState.groups === 0 && emptyState.emptyLabel) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  toolDetails.emptyCleared = emptyState.records === 0 && emptyState.groups === 0 && emptyState.emptyLabel;
  if (!toolDetails.emptyCleared) throw new Error('Previous tool records remained on an empty chat: ' + JSON.stringify(emptyState));
  fixtureOverride = null; publish();
  await new Promise(resolve => setTimeout(resolve, 200));
  await settingsWindow.webContents.executeJavaScript('document.getElementById("tab-display").click()');
  await new Promise(resolve => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(artifactDirectory, 'settings.png'), (await settingsWindow.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  const settingsFeatures = await require('./settings-smoke.cjs').checkSettingsFeatures({ win: settingsWindow, overlay, state: demoState(), settings, setFixture: value => { fixtureOverride = value; publish(); }, artifactDirectory });
  const usageCheck = await require('./smoke-usage.cjs').checkUsage({
    overlay, win: settingsWindow, settings, state: demoState(), artifactDirectory,
    setFixture(value, records = null) { fixtureOverride = value; fixtureRequests = records; publish(); },
  });
  await settingsWindow.webContents.executeJavaScript('document.getElementById("tab-diagnostics").click()');
  const settingsScroll = [];
  const settingsTypography = [];
  for (const size of [{ width: 560, height: 720 }, { width: 460, height: 500 }]) {
    settingsWindow.setSize(size.width, size.height);
    settingsWindow.focus();
    settingsWindow.webContents.focus();
    await settingsWindow.webContents.capturePage(undefined, { stayAwake: true });
    let viewport;
    for (let attempt = 0; attempt < 16; attempt++) {
      viewport = await settingsWindow.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })');
      if (Math.abs(viewport.width - size.width) <= 1 && Math.abs(viewport.height - size.height) <= 1) break;
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    if (Math.abs(viewport.width - size.width) > 1 || Math.abs(viewport.height - size.height) > 1) {
      throw new Error('Settings viewport failed to resize: ' + JSON.stringify({ size, viewport }));
    }
    const wheelPoint = await settingsWindow.webContents.executeJavaScript(`(() => {
      const scroll = document.getElementById('settings-scroll');
      scroll.scrollTop = 0;
      scroll.focus({ preventScroll: true });
      const bounds = scroll.getBoundingClientRect();
      return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
    })()`);
    await new Promise(resolve => setTimeout(resolve, 200));
    settingsWindow.webContents.sendInputEvent({ type: 'mouseWheel', ...wheelPoint, deltaY: -550, deltaX: 0, canScroll: true });
    await new Promise(resolve => setTimeout(resolve, 400));
    const wheel = await settingsWindow.webContents.executeJavaScript('document.getElementById("settings-scroll").scrollTop');
    settingsWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: ['control'] });
    settingsWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: ['control'] });
    await new Promise(resolve => setTimeout(resolve, 400));
    const bottom = await settingsWindow.webContents.executeJavaScript(`(() => {
      const scroll = document.getElementById('settings-scroll');
      const links = document.querySelector('.settings-links').getBoundingClientRect();
      const footer = document.querySelector('.settings-actions').getBoundingClientRect();
      const quit = document.getElementById('quit').getBoundingClientRect();
      const scrollBottom = scroll.getBoundingClientRect().bottom;
      return { scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
        captionPinned: Math.abs(document.querySelector('.settings-titlebar').getBoundingClientRect().top) < 1,
        actionsVisible: quit.bottom <= innerHeight + 1 && footer.bottom <= innerHeight + 1
          && Math.abs(links.top - scrollBottom) < 1 && Math.abs(footer.top - links.bottom) < 1,
        footerBounds: { top: footer.top, bottom: footer.bottom, scrollBottom, viewport: innerHeight } };
    })()`);
    settingsScroll.push({ size, wheel, ...bottom });
    if (bottom.scrollHeight > bottom.clientHeight && wheel <= 0 || !bottom.captionPinned || !bottom.actionsVisible || bottom.scrollHeight - bottom.clientHeight - bottom.scrollTop > 2) throw new Error('Settings scrolling failed: ' + JSON.stringify(settingsScroll.at(-1)));
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
      const scroll = document.getElementById('settings-scroll');
      const result = { fits, valuesAligned: values.every(value => Math.abs(value.left - values[0].left) < 1), pageFits: scroll.scrollWidth <= scroll.clientWidth, longStatusLines: status.getBoundingClientRect().height / parseFloat(getComputedStyle(status).lineHeight) };
      status.textContent = original;
      return result;
    })()`);
    settingsTypography.push({ size, ...typography });
    if (!typography.fits || !typography.valuesAligned || !typography.pageFits) throw new Error('Settings text overlaps or overflows: ' + JSON.stringify(settingsTypography.at(-1)));
    fs.writeFileSync(path.join(artifactDirectory, 'settings-bottom-' + size.width + '.png'), (await settingsWindow.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    const toolsFit = await settingsWindow.webContents.executeJavaScript(`(() => {
      document.getElementById('tab-tools').click();
      const details = document.getElementById('tool-classification'); details.open = true;
      document.getElementById('tool-details-heading').scrollIntoView();
      const table = document.querySelector('.tool-table-wrap');
      const records = document.getElementById('settings-tool-records');
      const scroll = document.getElementById('settings-scroll');
      return { pageFits: scroll.scrollWidth <= scroll.clientWidth, tableFits: table.scrollWidth <= table.clientWidth + 1, recordsFit: records.scrollWidth <= records.clientWidth + 1 };
    })()`);
    if (!toolsFit.pageFits || !toolsFit.tableFits || !toolsFit.recordsFit) throw new Error('Settings tool details overflow: ' + JSON.stringify(toolsFit));
    toolDetails[size.width] = toolsFit;
    await settingsWindow.webContents.executeJavaScript('document.getElementById("tool-classification").open = false');
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(artifactDirectory, 'settings-tools-' + size.width + '.png'), (await settingsWindow.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await settingsWindow.webContents.executeJavaScript(`(() => {
      document.getElementById('tab-diagnostics').click();
      const scroll = document.getElementById('settings-scroll');
      scroll.scrollTop = scroll.scrollHeight;
    })()`);
  }
  fs.writeFileSync(path.join(artifactDirectory, 'settings-bottom.png'), (await settingsWindow.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  const previousSettings = { ...settings.value };
  await settingsWindow.webContents.executeJavaScript(`const input = document.getElementById('offsetX'); input.value = '40'; input.dispatchEvent(new Event('change', { bubbles: true }));`);
  await settingsWindow.webContents.executeJavaScript("const toggle = document.querySelector('[data-setting=hideLabels]'); if (!toggle.checked) toggle.click();");
  await new Promise(resolve => setTimeout(resolve, 300));
  const savedStatus = await settingsWindow.webContents.executeJavaScript("document.getElementById('save-status').textContent");
  const reloadedSettings = new SettingsStore(app.getPath('userData'));
  const reloadedPosition = displayPosition(reloadedSettings.value, currentDisplay(), screen.getAllDisplays());
  if (savedStatus !== '已保存' || currentPositionSettings().offsetX !== 40 || reloadedPosition.offsetX !== 40 || !reloadedPosition.remembered) throw new Error('Settings UI did not persist the display position: ' + savedStatus);
  const hiddenText = await overlay.webContents.executeJavaScript(`(() => { document.getElementById('detail-tokens').querySelector('summary').click(); const result = { labelsHidden: [...document.querySelectorAll('.statusbar .k, .statusbar .route')].every(element => getComputedStyle(element).display === 'none'), valuesVisible: document.getElementById('speed').getBoundingClientRect().width > 0 && document.getElementById('speed').textContent.includes('28.4'), buttonsVisible: document.querySelector('[data-action=details]').getBoundingClientRect().width > 0 && document.querySelector('[data-action=settings]').getBoundingClientRect().width > 0, detailsReadable: document.getElementById('details').innerText.includes('输入 Token') && document.getElementById('tools-detail').innerText.includes('17 次') }; document.getElementById('detail-tokens').querySelector('summary').click(); return result; })()`);
  if (!reloadedSettings.value.hideLabels || Object.values(hiddenText).some(value => !value)) throw new Error('Hidden text setting failed: ' + JSON.stringify(hiddenText));
  const longDetails = demoState();
  longDetails.session.totals = { ...longDetails.session.totals, input_tokens: 339556220, total_tokens: 339580220 };
  longDetails.selection.title = '验证隐藏文字及窄窗口下的长聊天标题显示，明细标题应自动换行且不会遮挡统计内容。'.repeat(3);
  longDetails.session.turnToolUsage = { total: 45, failed: 0, timed: 30, durationMs: 111600, byType: [{ type: 'CommandExecution', label: '命令执行', total: 45, failed: 0, timed: 30, durationMs: 111600 }] };
  longDetails.session.toolUsage = { total: 211, failed: 16, timed: 151, durationMs: 499000, byType: [{ type: 'CommandExecution', label: '命令执行', total: 211, failed: 16, timed: 151, durationMs: 499000 }] };
  fixtureOverride = longDetails;
  publish();
  await new Promise(resolve => setTimeout(resolve, 400));
  const longTotal = await overlay.webContents.executeJavaScript("(() => { const total = document.getElementById('total-detail'); return { displayed: total.textContent, tooltip: total.title }; })()");
  if (longTotal.displayed !== '339.58M' || longTotal.tooltip !== '339,580,220 Token') throw new Error('Overview large total lost its compact label or exact value: ' + JSON.stringify(longTotal));
  const longDetailLayout = await overlay.webContents.executeJavaScript(`(() => { const panel = document.getElementById('details'); const label = document.getElementById('turn-tools-label'); const row = label.parentElement; const title = document.getElementById('chat-title'); return { labelWidth: label.getBoundingClientRect().width, labelHeight: label.getBoundingClientRect().height, valueWidth: document.getElementById('turn-tools-detail').getBoundingClientRect().width, rowHeight: row.getBoundingClientRect().height, shellFits: document.getElementById('shell').getBoundingClientRect().height <= document.documentElement.clientHeight + 2, titleFits: !title.hidden && title.scrollWidth <= title.clientWidth + 1 && panel.scrollWidth <= panel.clientWidth + 1, panelScrollable: panel.scrollHeight > panel.clientHeight }; })()`);
  if (longDetailLayout.labelWidth < 70 || longDetailLayout.labelHeight > 40 || !longDetailLayout.shellFits || !longDetailLayout.titleFits) throw new Error('Long details do not fit with hidden bar labels: ' + JSON.stringify(longDetailLayout));
  fs.writeFileSync(path.join(artifactDirectory, 'hidden-details.png'), (await overlay.webContents.capturePage()).toPNG());
  fixtureOverride = null;
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
  settings.update({ showSpeed: true, showContext: true, showTtft: true, showSession: true, showTurn: true, showToday: true, showCache: true, showTools: true, metricOrder: ['ttft', 'speed', 'context'], scale: 1.5 });
  publish();
  lastHost = { ...screen.getPrimaryDisplay().workArea, width: 350 };
  positionOverlay();
  await new Promise(resolve => setTimeout(resolve, 600));
  const narrow = await overlay.webContents.executeJavaScript(`(() => {
    const visible = document.querySelectorAll('.metric:not([hidden]):not(.overflowed)');
    return { compact: document.getElementById('shell').classList.contains('compact'),
      hidden: document.querySelectorAll('.metric.overflowed').length,
      extraHidden: document.querySelectorAll('.metric.overflowed[data-metric=today], .metric.overflowed[data-metric=cache]').length,
      more: document.getElementById('more-count').textContent,
      barFits: document.getElementById('bar').scrollWidth <= document.getElementById('bar').clientWidth + 1,
      metricsFit: document.getElementById('metrics').scrollWidth <= document.getElementById('metrics').clientWidth + 1,
      detailsList: document.getElementById('overflow-list').children.length,
      visibleMetrics: visible.length, firstVisible: visible[0]?.dataset.metric };
  })()`);
  const overflowActions = await overlay.webContents.executeJavaScript(`(async () => {
    document.getElementById('tab-overview').click();
    const button = document.querySelector('[data-action=details]'), panel = document.getElementById('details'), badge = document.getElementById('more-count');
    if (panel.classList.contains('open')) button.click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    document.querySelector('.metric:not([hidden]):not(.overflowed)')?.click();
    const metricKeptClosed = !panel.classList.contains('open'), labelDescribesHidden = button.getAttribute('aria-label').includes('收起指标');
    badge.click(); await new Promise(resolve => requestAnimationFrame(resolve));
    const summaryHasHiddenMetrics = [['total-detail','1,844,000'],['context-detail','114,400'],['turn-total-detail','86,420'],['speed-detail','28.4'],['tools-detail','17']].every(([id, value]) => { const node = document.getElementById(id); return node.textContent.includes(value) && node.getBoundingClientRect().height > 0; });
    return { metricKeptClosed, cOpened: panel.classList.contains('open'), badgeBelongsToC: badge.closest('button') === button, labelDescribesHidden, summaryHasHiddenMetrics };
  })()`);
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.join(artifactDirectory, 'narrow-details.png'), (await overlay.webContents.capturePage()).toPNG());
  if (Object.values(overflowActions).some(value => !value)) {
    const values = await overlay.webContents.executeJavaScript(`Object.fromEntries(['total-detail','context-detail','turn-total-detail','speed-detail','tools-detail'].map(id => { const node = document.getElementById(id); return [id, { text: node.textContent, height: node.getBoundingClientRect().height }]; }))`);
    throw new Error('Overflow hint changed C-only behavior: ' + JSON.stringify({ ...overflowActions, values }));
  }
  settings.update(previousSettings);
  publish();
  lastHost = previousHost;
  positionOverlay();
  await new Promise(resolve => setTimeout(resolve, 300));
  const expandedAgain = await overlay.webContents.executeJavaScript("!document.getElementById('shell').classList.contains('compact') && getComputedStyle(document.querySelector('.statusbar .k')).display !== 'none'");
  if (!narrow.compact || narrow.hidden < 1 || narrow.firstVisible !== 'ttft' || !narrow.barFits || !narrow.metricsFit || narrow.detailsList !== narrow.extraHidden || !expandedAgain) throw new Error('Window resizing did not preserve metric priority and access: ' + JSON.stringify(narrow));
  const docking = await smokeDocking();
  const interactions = process.argv.includes('--smoke-no-mouse') ? { skipped: true } : await require('./smoke-interactions.cjs').checkInteractions({ overlay, settingsWindow, settings, publish, positionOverlay, artifactDirectory });
  const report = { layout, settingsLayout, settingsScroll, settingsTypography, toolDetails, hiddenText, longDetailLayout, interactions, settingsPersistence: { uiChangeSaved: true, freshStoreRestored: true, reloadedControlRestored: true }, responsiveLabels: narrow.compact && expandedAgain, narrowOverflow: narrow, health: latest.health, ipcConnected: ipc.connected, selectionMode: latest.selection.mode, hasUsage: latest.session?.hasUsage ?? false };
  report.settingsFeatures = settingsFeatures;
  report.usage = usageCheck;
  report.opacity = opacityCheck;
  report.settingsUx = settingsUx;
  report.overflowActions = overflowActions;
  report.composerDocking = docking;
  fs.writeFileSync(path.join(artifactDirectory, 'smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ smoke: 'passed', health: report.health, ipcConnected: report.ipcConnected, selectionMode: report.selectionMode, overflow: layout.overflow }));
  app.quit();
}

async function smokeDocking() {
  const saved = { value: settings.value, lastHost, hostVisible, hostHandle, composerSample, overlaySize, manuallyHidden };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const work = screen.getPrimaryDisplay().workArea;
    lastHost = { x: work.x, y: work.y, width: Math.min(950, work.width), height: Math.min(740, work.height) };
    hostVisible = true; hostHandle = 123; manuallyHidden = false;
    composerSample = { handle: 123, at: Date.now(), host: { ...lastHost }, rect: { x: lastHost.x + 30, y: lastHost.y + lastHost.height - 120, width: lastHost.width - 60, height: 105 } };
    settings.update({ dockToComposer: true, dockTarget: 'composer', scale: 1, alwaysVisible: true, showSpeed: true, showContext: true, showSession: true, showTurn: false, showToday: false, showCache: false, showTools: false, hideLabels: true }); publish(); positionOverlay(); await wait(500);
    const initial = overlay.getBounds();
    if (!overlay.isVisible() || dockStatus !== 'above' || initial.y + initial.height > composerSample.rect.y) throw new Error('Composer docking overlapped input');
    const controls = await settingsWindow.webContents.executeJavaScript("document.querySelector('[data-setting=dockToComposer]').checked && ['placement','allowDrag','offsetX','offsetY','alwaysVisible'].every(k => document.querySelector('[data-setting='+k+']').disabled)");
    if (!controls) throw new Error('Composer controls did not reflect docking mode');
    const alignments = {};
    for (const alignment of ['left', 'center', 'right']) {
      composerSample.at = Date.now();
      await settingsWindow.webContents.executeJavaScript(`(() => { const input = document.getElementById('composer-alignment'); input.value = '${alignment}'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      for (let attempt = 0; settings.value.composerAlignment !== alignment && attempt < 30; attempt++) await wait(50);
      if (settings.value.composerAlignment !== alignment || new SettingsStore(path.dirname(settings.filename)).value.composerAlignment !== alignment) throw new Error('Composer alignment did not persist');
      const samples = [];
      for (const open of [false, true]) {
        await overlay.webContents.executeJavaScript(`(() => { const button = document.querySelector('[data-action=details]'); if (button.getAttribute('aria-expanded') !== '${open}') button.click(); })()`);
        let match = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          await wait(50);
          const bar = await overlay.webContents.executeJavaScript("(() => { const r=document.getElementById('bar').getBoundingClientRect(); return {x:r.x,width:r.width}; })()");
          const win = overlay.getBounds(), input = composerSample.rect;
          const actual = win.x + bar.x + (alignment === 'center' ? bar.width / 2 : alignment === 'right' ? bar.width : 0);
          const expected = input.x + (alignment === 'center' ? input.width / 2 : alignment === 'right' ? input.width - 8 : 8);
          if (Math.abs(actual - expected) <= 2) { match = true; samples.push({ open, error: Math.round((actual - expected) * 100) / 100 }); break; }
        }
        if (!match) throw new Error('Visible composer bar failed ' + alignment + ' alignment, open=' + open);
      }
      alignments[alignment] = samples;
    }
    const loaded = new Promise(resolve => settingsWindow.webContents.once('did-finish-load', resolve));
    settingsWindow.webContents.reload(); await loaded; await wait(250);
    const restoredAlignment = await settingsWindow.webContents.executeJavaScript("document.getElementById('composer-alignment').value === 'right' && !document.getElementById('composer-alignment').disabled");
    if (!restoredAlignment) throw new Error('Composer alignment did not restore after reloading settings');
    const titlebarChecks = [];
    // Reproduce changing dock regions after the old region has disappeared.
    composerSample = null; positionOverlay(); await wait(150);
    if (overlay.isVisible()) throw new Error('Missing dock region should hide before recovery');
    overlay.webContents.setBackgroundThrottling(true);
    settings.update({ scale: 1.5 });
    await settingsWindow.webContents.executeJavaScript("(() => { const input=document.getElementById('dock-target'); input.value='titlebar'; input.dispatchEvent(new Event('change',{bubbles:true})); })()");
    for (let attempt = 0; settings.value.dockTarget !== 'titlebar' && attempt < 30; attempt++) await wait(50);
    if (settings.value.dockTarget !== 'titlebar' || new SettingsStore(path.dirname(settings.filename)).value.dockTarget !== 'titlebar') throw new Error('Titlebar target did not persist');
    composerSample = { handle: 123, target: 'titlebar', at: Date.now(), host: { ...lastHost }, rect: { x: lastHost.x + 260, y: lastHost.y + 4, width: lastHost.width - 420, height: 36 } };
    publish(); positionOverlay();
    for (let attempt = 0; !overlay.isVisible() && attempt < 40; attempt++) await wait(50);
    const hiddenRegionRecovered = overlay.isVisible();
    if (!hiddenRegionRecovered) throw new Error('Hidden docked renderer failed to remeasure the new titlebar region');
    overlay.webContents.setBackgroundThrottling(false);
    for (const alignment of ['left', 'center', 'right']) {
      settings.update({ composerAlignment: alignment }); composerSample.at = Date.now(); publish(); positionOverlay();
      for (const open of [false, true]) {
        await overlay.webContents.executeJavaScript(`(() => { const button = document.querySelector('[data-action=details]'); if (button.getAttribute('aria-expanded') !== '${open}') button.click(); })()`);
        let passed = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          await wait(50);
          const layout = await overlay.webContents.executeJavaScript("(() => { const b=document.getElementById('bar').getBoundingClientRect(), d=document.getElementById('details').getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height,zoom:Number(document.body.style.zoom),detailsBelow:d.top>=b.bottom,bottom:document.getElementById('shell').classList.contains('bottom')}; })()");
          const win = overlay.getBounds(), area = composerSample.rect;
          const actual = win.x + layout.x + (alignment === 'center' ? layout.width / 2 : alignment === 'right' ? layout.width : 0);
          const expected = area.x + (alignment === 'center' ? area.width / 2 : alignment === 'right' ? area.width - 8 * layout.zoom : 8 * layout.zoom);
          if (overlay.isVisible() && dockStatus === 'titlebar' && Math.abs(actual - expected) <= 2 && win.y + layout.y >= area.y && win.y + layout.y + layout.height <= area.y + area.height && !layout.bottom && (!open || layout.detailsBelow)) { titlebarChecks.push({ alignment, open, height: layout.height, zoom: layout.zoom }); passed = true; break; }
        }
        if (!passed) throw new Error('Titlebar fit/alignment/downward details failed: ' + alignment + ' open=' + open);
      }
    }
    await settingsWindow.webContents.executeJavaScript("document.getElementById('tab-position').click(); document.getElementById('composer-alignment').scrollIntoView({block:'center'});");
    if (settingsWindow.isMinimized()) settingsWindow.restore(); settingsWindow.showInactive(); await wait(200);
    fs.writeFileSync(path.join(artifactDirectory, 'composer-alignment-settings.png'), (await settingsWindow.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    composerSample.at = Date.now() - 4000; positionOverlay();
    if (overlay.isVisible()) throw new Error('Stale composer kept an overlay visible');
    composerSample.at = Date.now(); positionOverlay();
    if (!overlay.isVisible()) throw new Error('Fresh composer did not recover');
    hostVisible = false; positionOverlay();
    if (overlay.isVisible()) throw new Error('Docked bar leaked over another application');
    hostVisible = true; composerSample = null; positionOverlay();
    if (overlay.isVisible()) throw new Error('Missing composer reused previous position');
    return { avoidsInput: true, controls: true, alignments, restoredAlignment, titlebarChecks, hiddenRegionRecovered, staleHidden: true, freshRecovered: true, otherAppHidden: true, missingInputHidden: true };
  } finally {
    overlay.webContents.setBackgroundThrottling(false);
    settings.update(saved.value); ({ lastHost, hostVisible, hostHandle, composerSample, overlaySize, manuallyHidden } = saved);
    publish(); positionOverlay();
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_, args) => {
    if (args.includes('--quit')) { app.quit(); return; }
    if (args.includes('--autostart')) return;
    manuallyHidden = false;
    positionOverlay();
    openSettings(args.includes('--updates') || isNotificationLaunch(args) ? 'updates' : undefined);
  });
  app.whenReady().then(async () => {
    settings = new SettingsStore(app.getPath('userData'));
    lastNotifiedRelease = settings.value.lastNotifiedRelease;
    store = new SessionStore(undefined, { cacheDirectory: smoke || demo ? null : app.getPath('userData') });
    ipc = new CodexIpc();
    // Renderers cannot request remote resources. Update checks use an isolated,
    // in-memory session with a single allowed endpoint and no credentials.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_, callback) => callback({ cancel: true }));
    updateSession = session.fromPartition('codex-token-update', { cache: false });
    updateSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== UPDATE_URL || details.method !== 'GET' }));
    createOverlay();
    if (!smoke && !demo) buildTray();
    ipcMain.on('statusbar:ready', event => { if (validSender(event)) { if (demo) event.sender.send('statusbar:snapshot', demoState()); else publish(); } });
    ipcMain.on('statusbar:resize', (event, size) => {
      if (event.sender !== overlay.webContents || !Number.isFinite(size?.width) || !Number.isFinite(size?.height)) return;
      overlaySize = { width: Math.max(260, Math.min(1400, Math.ceil(size.width))), height: Math.max(20, Math.min(1600, Math.ceil(size.height))), barHeight: Number.isFinite(size.barHeight) ? Math.max(20, Math.min(160, Math.ceil(size.barHeight))) : overlaySize.barHeight };
      positionOverlay();
    });
    ipcMain.on('statusbar:drag', (event, action, point) => { if (event.sender === overlay.webContents && ['start', 'move', 'end', 'cancel'].includes(action)) dragOverlay(action, point); });
    ipcMain.on('statusbar:opacity-preview', (event, value) => { if (settingsWindow && event.sender === settingsWindow.webContents) previewOpacity(value); });
    ipcMain.on('statusbar:open-settings', (event, pane) => { if (validSender(event)) openSettings(pane); });
    ipcMain.handle('statusbar:restore-position', event => {
      if (!validSender(event)) throw new Error('Invalid sender');
      try { restorePosition(); return { ok: true }; } catch (error) { return settingsFailure(error); }
    });
    ipcMain.on('statusbar:refresh', event => { if (validSender(event)) refreshData(); });
    ipcMain.on('statusbar:tool-interest', (event, enabled) => {
      if (event.sender !== settingsWindow?.webContents) return;
      settingsWantsTools = enabled === true;
      queuePublish();
    });
    ipcMain.handle('statusbar:model-requests', (event, threadId, filters) => {
      if (!validSender(event)) throw new Error('Invalid sender');
      if (!threadId) return null;
      if (fixtureOverride || previewFixture || demo) {
        const selected = fixtureOverride ? fixtureOverride.session : demoState().session;
        return threadId === selected?.threadId ? requestPage(fixtureRequests, filters) : null;
      }
      return threadId === latest?.session?.threadId ? store.modelRequests(threadId, filters) : null;
    });
    ipcMain.handle('statusbar:copy-diagnostics', event => {
      if (event.sender !== settingsWindow?.webContents) throw new Error('Invalid sender');
      const text = diagnosticSummary(latest, `${process.platform}-${process.arch}`);
      if (!smoke) clipboard.writeText(text);
      return smoke ? { ok: true, text } : { ok: true };
    });
    ipcMain.handle('statusbar:open-release', async event => {
      if (event.sender !== settingsWindow?.webContents) throw new Error('Invalid sender');
      if (!smoke) await shell.openExternal(RELEASE_URL);
      return { ok: true };
    });
    ipcMain.handle('statusbar:open-settings-link', async (event, url) => {
      if (event.sender !== settingsWindow?.webContents || !settingsLinks.has(url)) throw new Error('Invalid settings link');
      if (!smoke) await shell.openExternal(url);
    });
    ipcMain.handle('statusbar:check-update', async event => {
      if (event.sender !== settingsWindow?.webContents) throw new Error('Invalid sender');
      return checkUpdates();
    });
    ipcMain.on('statusbar:quit', event => { if (validSender(event)) app.quit(); });
    ipcMain.handle('statusbar:settings', (event, patch) => {
      if (!validSender(event)) throw new Error('Invalid sender');
      let value;
      const previousUpdateMode = settings.value.updateMode;
      try { value = updatePositionSettings(patch); }
      catch (error) {
        if (patch && Object.hasOwn(patch, 'opacity')) previewOpacity(null);
        return settingsFailure(error);
      }
      if (value.updateMode !== previousUpdateMode) scheduleUpdateCheck();
      publish();
      if (patch && Object.hasOwn(patch, 'opacity')) previewOpacity(null);
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
    void refreshQuota();
    if (nativeUpdates) Notification.handleActivation(details => {
      if (details.type === 'click' && details.arguments === updateActivation) openUpdateNotification();
    });
    scheduleUpdateCheck();
    if (isNotificationLaunch(process.argv)) openUpdateNotification();
    else if (process.argv.includes('--updates') && !smoke && !demo) openSettings('updates');
    if (!smoke && !demo) watcherWatchdog = setInterval(checkWatcher, 1000);
    if (demo) overlay.webContents.once('did-finish-load', () => overlay.webContents.send('statusbar:snapshot', demoState()));
    if (smoke) smokeCheck().catch(error => { console.error(error.stack ?? error.message); app.exit(1); });
  }).catch(error => { console.error(error.stack ?? error.message); app.exit(1); });
}
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  clearTimeout(publishTimer);
  clearTimeout(updateTimer);
  clearTimeout(quotaTimer);
  quotaRequest?.abort();
  clearInterval(watcherWatchdog);
  ipc?.stop();
  navigation?.stop();
  visibleChat?.stop();
  store?.stop();
  nativeWatcher?.stop();
  tray?.destroy();
});
