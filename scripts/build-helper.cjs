'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function buildHelper() {
  if (process.platform !== 'win32') throw new Error('The Windows helper must be built on Windows.');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const source = ['WindowApi.cs', 'WindowHelper.cs'].map(name => path.join(root, 'native', name));
  const directory = path.join(root, 'artifacts', 'native-helper');
  const executable = path.join(directory, 'WindowHelper.exe');
  const hash = crypto.createHash('sha256').update('x64-netfx-v1').update(source.map(name => fs.readFileSync(name, 'utf8')).join('\n')).digest('hex');
  const stamp = path.join(directory, 'source.sha256');
  if (fs.existsSync(executable) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) return executable;
  fs.mkdirSync(directory, { recursive: true });
  const references = [path.join(framework, 'System.Web.Extensions.dll'), ...['WindowsBase.dll', 'UIAutomationClient.dll', 'UIAutomationTypes.dll'].map(name => path.join(framework, 'WPF', name))];
  const result = spawnSync(path.join(framework, 'csc.exe'), ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', '/out:' + executable, ...references.map(name => '/reference:' + name), ...source], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Windows helper build failed: ' + (result.stdout || result.stderr || result.error?.code));
  fs.writeFileSync(stamp, hash);
  return executable;
}
if (require.main === module) { try { console.log(buildHelper()); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { buildHelper };
