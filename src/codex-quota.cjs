'use strict';

const { execFile, spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { promisify } = require('node:util');
const { normalizeQuota } = require('./metrics.cjs');

const home = os.homedir();

async function findCodex(signal) {
  const windows = process.platform === 'win32';
  const name = windows ? 'codex.exe' : 'codex';
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const executable = path.join(directory, name);
    if (existsSync(executable)) return executable;
  }
  if (!windows) return null;
  // Explorer launches often lack the Desktop package's directory on PATH.
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation',
  ], { cwd: home, windowsHide: true, timeout: 5000, maxBuffer: 8192, signal });
  const location = stdout.trim();
  if (!path.isAbsolute(location)) return null;
  const executable = path.join(location, 'app', 'resources', name);
  return existsSync(executable) ? executable : null;
}

function parseOfficialQuota(result, recordedAt = Date.now()) {
  const single = result?.rateLimits;
  const bucket = result?.rateLimitsByLimitId?.codex ?? (single?.limitId == null || single.limitId === 'codex' ? single : null);
  if (!bucket || typeof bucket !== 'object' || !('primary' in bucket || 'secondary' in bucket)) return null;
  const samples = [bucket.primary, bucket.secondary].map(window => window && ({
    percent: window.usedPercent, minutes: window.windowDurationMins, reset: window.resetsAt,
  }));
  const quota = normalizeQuota(samples, bucket.planType, bucket.limitName, recordedAt);
  if (!quota || !quota.windows.length && samples.some(Boolean)) return null;
  return { ...quota, source: 'official' };
}

function readAppServerQuota(executable, version, signal) {
  return new Promise(resolve => {
    const child = spawn(executable, ['app-server'], {
      cwd: home, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], signal,
    });
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let finished = false;
    const timer = setTimeout(finish, 20000);
    function finish(quota = null) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reader.close();
      child.stdin.destroy();
      child.kill();
      resolve(quota);
    }
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    child.once('error', () => finish());
    child.once('close', () => finish());
    child.stdin.once('error', () => finish());
    child.once('spawn', () => send({
      id: 0, method: 'initialize', params: { clientInfo: { name: 'codex_token_statusbar', title: 'Codex Token Statusbar', version } },
    }));
    reader.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message?.id === 0) {
        if (!message.result) { finish(); return; }
        send({ method: 'initialized', params: {} });
        send({ id: 1, method: 'account/rateLimits/read' });
      } else if (message?.id === 1) {
        finish(parseOfficialQuota(message.result));
      }
    });
  });
}

async function readCodexQuota(version, signal) {
  try {
    const executable = await findCodex(signal);
    if (executable && !signal.aborted) return await readAppServerQuota(executable, version, signal);
  } catch { /* The caller can still show the last available quota record. */ }
  return null;
}

module.exports = { readCodexQuota, parseOfficialQuota };
