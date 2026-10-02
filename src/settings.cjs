'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { UUID } = require('./codex-ipc.cjs');

const DEFAULTS = Object.freeze({
  theme: 'system', placement: 'top-right', scale: 1, alwaysVisible: false,
  showSpeed: true, showContext: true, showSession: true, showTurn: false,
  showToday: false, showCache: false, showTools: false, pinnedThreadId: null, contextOverride: null,
  offsetX: 0, offsetY: 0, allowDrag: false, hideLabels: false,
});

function cleanSettings(input, previous = DEFAULTS) {
  const result = { ...previous };
  if (!input || typeof input !== 'object') return result;
  for (const key of ['showSpeed', 'showContext', 'showSession', 'showTurn', 'showToday', 'showCache', 'showTools', 'alwaysVisible', 'allowDrag', 'hideLabels']) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  if (['system', 'dark', 'light'].includes(input.theme)) result.theme = input.theme;
  if (['top-right', 'bottom-right', 'bottom-center'].includes(input.placement)) result.placement = input.placement;
  if (Number.isFinite(input.scale)) result.scale = Math.max(0.75, Math.min(1.5, input.scale));
  if (input.pinnedThreadId === null || UUID.test(input.pinnedThreadId ?? '')) result.pinnedThreadId = input.pinnedThreadId;
  if (input.contextOverride === null || Number.isSafeInteger(input.contextOverride) && input.contextOverride >= 1000 && input.contextOverride <= 10000000) result.contextOverride = input.contextOverride;
  for (const key of ['offsetX', 'offsetY']) if (Number.isFinite(input[key])) result[key] = Math.max(-20000, Math.min(20000, Math.round(input[key])));
  if (!['showSpeed', 'showContext', 'showSession', 'showTurn', 'showToday', 'showCache', 'showTools'].some(key => result[key])) result.showContext = true;
  return result;
}

class SettingsStore {
  constructor(directory) {
    this.filename = path.join(directory, 'settings.json');
    this.value = { ...DEFAULTS };
    try { this.value = cleanSettings(JSON.parse(fs.readFileSync(this.filename, 'utf8'))); } catch {}
  }
  update(patch) {
    const next = cleanSettings(patch, this.value);
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    try {
      fs.renameSync(temporary, this.filename);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      // Some Windows profile filesystems reject even same-directory renames.
      fs.copyFileSync(temporary, this.filename);
      try { fs.unlinkSync(temporary); } catch {}
    }
    this.value = next;
    return this.value;
  }
}
module.exports = { SettingsStore, DEFAULTS, cleanSettings };
