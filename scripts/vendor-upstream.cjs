'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const commit = 'ac328de0523f60b83d0c5cd3ccacda8eda86f55e';

(async () => {
  const root = path.join(__dirname, '..');
  const directory = path.join(root, 'third_party', 'zcode');
  await fs.mkdir(directory, { recursive: true });
  const files = await Promise.all(['overlay.js', 'LICENSE'].map(async filename => {
    try { return await fs.readFile(path.join(directory, filename), 'utf8'); } catch {}
    const response = await fetch(`https://raw.githubusercontent.com/xhwxt/zcode-token-usage-statusbar/${commit}/${filename}`);
    if (!response.ok) throw new Error(`upstream-${response.status}`);
    const text = await response.text();
    await fs.writeFile(path.join(directory, filename), text, 'utf8');
    return text;
  }));
  const start = files[0].indexOf('style.textContent =');
  const end = files[0].indexOf('/* 结构：', start);
  if (start < 0 || end < 0) throw new Error('upstream-css-not-found');
  const literals = files[0].slice(start, end).split('\n').map(line => line.match(/^\s*("(?:[^"\\]|\\.)*")\s*[+;]/)).filter(Boolean);
  const css = literals.map(match => JSON.parse(match[1])).join('');
  if (!css.includes('.zusage-root') || !css.includes('.cbar')) throw new Error('upstream-css-incomplete');
  await fs.mkdir(path.join(root, 'src', 'ui'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'ui', 'upstream.css'), `/* Adapted from xhwxt/zcode-token-usage-statusbar, MIT, ${commit}. */\n${css}\n`);
  console.log(`Retained upstream license and ${css.length} characters of capsule/panel CSS.`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
