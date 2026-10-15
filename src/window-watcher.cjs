'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
function validGeometry(sample) {
  return sample && typeof sample.visible === 'boolean' && safeInteger(sample.processId) && safeInteger(sample.windowCount) && (!sample.visible || safeInteger(sample.handle) && sample.handle > 0 && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(sample[key]) && Math.abs(sample[key]) < 100000) && sample.width >= 350 && sample.height >= 250);
}
class WindowWatcher extends EventEmitter {
  constructor({ executable, script, ownerPid = process.pid, spawnProcess = spawn, exists = fs.existsSync, now = Date.now, retryMs = 2000, timeoutMs = 7000 } = {}) {
    super(); Object.assign(this, { executable, script, ownerPid, spawnProcess, now, retryMs, timeoutMs });
    this.backend = exists(executable) ? 'independent' : 'powershell';
    this.geometry = null; this.title = null; this.geometryAt = 0; this.titleAt = 0;
    this.error = null; this.titleError = null; this.geometryFailures = 0;
    this.target = null; this.stopped = false; this.geometryTimer = null; this.titleTimer = null;
  }
  status() {
    return { backend: this.backend, geometryRunning: Boolean(this.geometry && !this.geometry.killed), geometryHealthy: Boolean(this.geometryAt && this.now() - this.geometryAt < this.timeoutMs), titleHealthy: this.backend === 'powershell' ? Boolean(this.geometryAt && this.now() - this.geometryAt < this.timeoutMs) : Boolean(this.titleAt && this.now() - this.titleAt < this.timeoutMs), error: this.error, titleError: this.titleError };
  }
  readLines(child, callback) {
    let pending = ''; child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      pending += text; const lines = pending.split('\n'); pending = lines.pop();
      if (pending.length > 32768) pending = '';
      for (const line of lines) { if (line.length > 32768) continue; let value; try { value = JSON.parse(line); } catch { continue; } callback(value); }
    });
  }
  start() { if (!this.stopped && !this.geometry) this.startGeometry(); }
  startGeometry() {
    if (this.stopped) return;
    const independent = this.backend === 'independent';
    const executable = independent ? this.executable : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = independent ? ['--owner', String(this.ownerPid)] : ['-MTA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-OverlayProcessId', String(this.ownerPid)];
    const child = this.geometry = this.spawnProcess(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.geometryStarted = this.now(); this.geometryAt = 0;
    this.readLines(child, sample => {
      if (this.stopped || this.geometry !== child || !validGeometry(sample)) return;
      this.geometryAt = this.now(); this.error = null; this.geometryFailures = 0;
      if (independent) {
        const target = sample.visible ? { handle: sample.handle, processId: sample.processId } : { handle: 0, processId: 0 };
        if (sample.visible && (!this.target || target.handle !== this.target.handle || target.processId !== this.target.processId)) this.emit('title', { ...target, documentTitle: null });
        this.target = target;
        this.sendTarget();
      }
      this.emit('sample', sample);
    });
    child.stderr.on('data', () => { this.error = '窗口助手报告错误，正在恢复'; this.emit('status'); });
    child.on('error', () => { this.error = '窗口助手无法启动，正在重试'; this.emit('status'); });
    child.on('close', () => {
      if (this.geometry !== child) return;
      this.geometry = null; this.geometryAt = 0; this.geometryFailures++;
      this.target = { handle: 0, processId: 0 }; this.sendTarget();
      this.emit('reset');
      if (this.stopped) return;
      if (independent && this.geometryFailures >= 3) { this.backend = 'powershell'; this.stopTitle(); this.error = '已切换 PowerShell 兼容助手'; }
      this.emit('status'); this.geometryTimer = setTimeout(() => this.startGeometry(), this.retryMs);
    });
    if (independent && !this.title && !this.titleTimer) this.startTitle();
  }
  sendTarget() {
    if (!this.target || !this.title?.stdin?.writable || this.title.stdin.destroyed || this.title.stdin.writableNeedDrain) return;
    this.title.stdin.write(JSON.stringify(this.target) + '\n');
  }
  startTitle() {
    this.titleTimer = null;
    if (this.stopped || this.backend !== 'independent') return;
    const child = this.title = this.spawnProcess(this.executable, ['--title', '--owner', String(this.ownerPid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.titleStarted = this.now(); this.titleAt = 0;
    child.stdin.on('error', () => {});
    this.sendTarget();
    this.readLines(child, sample => {
      if (this.stopped || this.title !== child || !safeInteger(sample.handle) || !safeInteger(sample.processId) || !(sample.documentTitle === null || typeof sample.documentTitle === 'string' && sample.documentTitle.length <= 2048)) return;
      this.titleAt = this.now(); this.titleError = sample.unavailable ? '标题暂不可读，页面 ID 识别仍可用' : null;
      if (!sample.idle && this.target?.handle === sample.handle && this.target?.processId === sample.processId) this.emit('title', sample);
      this.emit('status');
    });
    child.stderr.on('data', () => { this.titleError = '标题助手报告错误，页面 ID 识别仍可用'; this.emit('status'); });
    child.on('error', () => { this.titleError = '标题助手无法启动，页面 ID 识别仍可用'; this.emit('status'); });
    child.on('close', () => {
      if (this.title !== child) return;
      this.title = null; this.titleAt = 0;
      if (this.target?.handle) this.emit('title', { ...this.target, documentTitle: null });
      if (!this.stopped && this.backend === 'independent') this.titleTimer = setTimeout(() => this.startTitle(), this.retryMs);
      this.emit('status');
    });
  }
  check() {
    if (this.stopped) return;
    if (this.geometry && this.now() - (this.geometryAt || this.geometryStarted) >= this.timeoutMs) { this.error = '窗口助手无响应，正在重启'; this.geometry.kill(); this.emit('status'); }
    if (this.title && this.now() - (this.titleAt || this.titleStarted) >= this.timeoutMs) {
      this.titleError = '标题通道超时，正在重启；窗口跟随继续运行';
      if (this.target?.handle) this.emit('title', { ...this.target, documentTitle: null });
      this.title.kill(); this.emit('status');
    }
  }
  stopTitle() { clearTimeout(this.titleTimer); this.titleTimer = null; const child = this.title; this.title = null; child?.kill(); }
  stop() { this.stopped = true; clearTimeout(this.geometryTimer); this.stopTitle(); const child = this.geometry; this.geometry = null; child?.kill(); }
}
module.exports = { WindowWatcher, validGeometry };
