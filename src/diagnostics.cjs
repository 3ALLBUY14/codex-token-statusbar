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
    tools: { completed: s.session?.toolUsage?.total ?? 0, failed: s.session?.toolUsage?.failed ?? 0 },
  }, null, 2);
}
module.exports = { RELEASE_URL, UPDATE_URL, versionParts, newerVersion, diagnosticSummary };
