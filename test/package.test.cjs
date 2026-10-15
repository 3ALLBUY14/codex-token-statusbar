'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { slimLocales } = require('../scripts/package.cjs');
test('locale slimming keeps Chinese, English and non-locale assets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'statusbar-package-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const locales = path.join(root, 'locales'); await fs.mkdir(locales);
  for (const name of ['en-US.pak', 'zh-CN.pak', 'fr.pak', 'ja.pak', 'NOTICE.txt']) await fs.writeFile(path.join(locales, name), 'test');
  const report = await slimLocales(root);
  assert.equal(report.removedCount, 2); assert.equal(report.removedBytes, 8);
  assert.deepEqual((await fs.readdir(locales)).sort(), ['NOTICE.txt', 'en-US.pak', 'zh-CN.pak']);
});
