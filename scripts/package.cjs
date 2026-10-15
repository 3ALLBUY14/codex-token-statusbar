'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildHelper } = require('./build-helper.cjs');
const root = path.resolve(__dirname, '..');
async function slimLocales(packageRoot) {
  const directory = path.join(packageRoot, 'locales');
  let removedBytes = 0, removedCount = 0;
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith('.pak') || ['en-US.pak', 'zh-CN.pak'].includes(item.name)) continue;
    const filename = path.join(directory, item.name), stat = await fs.stat(filename);
    await fs.unlink(filename); removedBytes += stat.size; removedCount++;
  }
  return { removedCount, removedBytes };
}
async function packageApp() {
  const helper = buildHelper();
  const { packager } = await import('@electron/packager');
  const output = await packager({
    dir: root, name: 'CodexTokenStatusbar', platform: 'win32', arch: 'x64', out: path.join(root, 'dist'), overwrite: true, asar: true,
    electronZipDir: path.join(root, 'artifacts'), extraResource: [path.join(root, 'scripts', 'window-watch.ps1'), helper],
    ignore: /^\/(dist|release|installer|test|artifacts|docs|native|\.github|\.git|node_modules\/\.cache)(\/|$)/,
  });
  const report = await slimLocales(output[0]);
  await fs.writeFile(path.join(root, 'artifacts', 'package-size-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ package: path.basename(output[0]), ...report }));
}
if (require.main === module) packageApp().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { slimLocales };
