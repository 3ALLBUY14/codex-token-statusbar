'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { buildHelper } = require('./build-helper.cjs');
const root = path.resolve(__dirname, '..');
async function nativeProbe(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('helper-probe-timeout')); }, 5000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { output += text; if (input && output.includes('\n')) child.kill(); });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { errors += text; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', () => { clearTimeout(timer); try { if (errors) throw new Error('helper-stderr'); resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); } });
    if (input) child.stdin.write(JSON.stringify(input) + '\n');
  });
}
async function verify() {
  const executable = buildHelper();
  const geometry = await nativeProbe(executable, ['--once']); assert.equal(typeof geometry.visible, 'boolean'); assert.ok(Number.isInteger(geometry.windowCount));
  const title = await nativeProbe(executable, ['--title', '--owner', String(process.pid)], { handle: 0, processId: 0 }); assert.equal(title.idle, true);
  const child = spawn(executable, ['--owner', '2147483647'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const parentExit = await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(false); }, 3000); child.once('close', () => { clearTimeout(timer); resolve(true); }); });
  assert.ok(parentExit);
  const report = { geometry: true, titleHeartbeat: true, exitsWithoutParent: true, geometrySnapshot: { visible: geometry.visible, windowCount: geometry.windowCount } };
  await fs.writeFile(path.join(root, 'artifacts', 'helper-verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
if (require.main === module) verify().catch(error => { console.error(error.message); process.exitCode = 1; });
