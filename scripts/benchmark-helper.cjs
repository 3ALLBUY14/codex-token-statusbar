'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { WindowWatcher } = require('../src/window-watcher.cjs');
const { buildHelper } = require('./build-helper.cjs');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function measure(executable, independent) {
  const watcher = new WindowWatcher({ executable, script: path.join(root, 'scripts', 'window-watch.ps1'), exists: () => independent });
  const start = performance.now();
  try {
    const first = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('helper-startup-timeout')), 15000);
      watcher.once('sample', () => { clearTimeout(timeout); resolve(performance.now() - start); });
    });
    watcher.start(); const firstSampleMs = await first; await pause(2200);
    const pids = [watcher.geometry?.pid, watcher.title?.pid].filter(Number.isInteger);
    const script = '$items = @(' + pids.join(',') + ') | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }; [pscustomobject]@{WorkingSetBytes=($items | Measure-Object WorkingSet64 -Sum).Sum; CpuSeconds=($items | Measure-Object CPU -Sum).Sum; Processes=@($items).Count} | ConvertTo-Json -Compress';
    const process = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    if (process.status !== 0) throw new Error('process-metrics-failed');
    return { firstSampleMs: Math.round(firstSampleMs), ...JSON.parse(process.stdout), ...watcher.status() };
  } finally { watcher.stop(); }
}
async function benchmark() {
  const executable = buildHelper();
  const independent = [], compatibility = [];
  for (let i = 0; i < 3; i++) { independent.push(await measure(executable, true)); compatibility.push(await measure(executable, false)); }
  const report = { independent, compatibility, note: 'Working sets may share memory; this is a local process snapshot, not unique physical memory. Three starts per backend; CPU sampled after a short warm-up.' };
  const output = path.join(root, 'artifacts', 'helper-benchmark.json'); await fs.writeFile(output, JSON.stringify(report, null, 2));
  const median = rows => [...rows].sort((a, b) => a.firstSampleMs - b.firstSampleMs)[1];
  console.log(JSON.stringify({ independent: median(independent), compatibility: median(compatibility) }, null, 2));
}
if (require.main === module) benchmark().catch(error => { console.error(error.message); process.exitCode = 1; });
