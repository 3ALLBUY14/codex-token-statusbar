'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function checkUsage({ overlay, win, settings, state, setFixture, artifactDirectory }) {
  const previous = { ...settings.value }, bounds = win.getBounds(), fixture = structuredClone(state);
  const counts = (n, requests = 2) => ({ input_tokens: n, output_tokens: 100, cached_input_tokens: n / 2, reasoning_output_tokens: 30, total_tokens: n + 100, requests });
  fixture.session.accounting = { method: 'response', totals: counts(1000), requests: 2, partial: true, byModel: [{ model: '测试模型 GPT · 长名称换行检查', ...counts(1000) }], bySource: [{ source: 'task', ...counts(1000) }], relatedThreads: 1,
    related: { totals: { ...counts(2000, 3), output_tokens: 200, reasoning_output_tokens: 60, total_tokens: 2200 }, requests: 3, partial: true, byModel: [{ model: '测试模型 GPT · 长名称换行检查', ...counts(1000) }, { model: '子代理模型', ...counts(1000, 1) }], bySource: [{ source: 'task', ...counts(1000) }, { source: 'subagent', ...counts(1000, 1) }] } };
  const result = {};
  try {
    settings.update({ dockToComposer: false }); setFixture(fixture); await pause(200);
    await win.webContents.executeJavaScript("document.getElementById('tab-chat').click(); const s=document.querySelector('#settings-usage-details select');s.value='related';s.dispatchEvent(new Event('change',{bubbles:true}));");
    result.scopeWorks = await win.webContents.executeJavaScript("document.getElementById('settings-usage-details').innerText.includes('2,200 Token') && document.getElementById('settings-usage-details').innerText.includes('子代理模型')");
    await overlay.webContents.executeJavaScript("document.getElementById('detail-usage').open=true"); await pause(150);
    result.detailsWork = await overlay.webContents.executeJavaScript("document.getElementById('usage-details').innerText.includes('1,100 Token') && document.getElementById('usage-details').innerText.includes('不完整')");
    overlay.webContents.send('statusbar:snapshot', { ...fixture, session: { ...fixture.session, totals: counts(999999) }, delivery: { sequence: 0, epoch: 0 } });
    win.webContents.send('statusbar:snapshot', { ...fixture, session: null, delivery: { sequence: 0, epoch: 0 } }); await pause(100);
    result.staleRejected = await overlay.webContents.executeJavaScript("!document.getElementById('session').textContent.includes('999')") && await win.webContents.executeJavaScript("document.getElementById('settings-usage-details').innerText.includes('子代理模型')");
    result.layouts = [];
    for (const width of [650, 460]) {
      win.setSize(width, 720); if (win.isMinimized()) win.restore(); win.showInactive();
      await win.webContents.executeJavaScript("document.getElementById('settings-usage-details').scrollIntoView({block:'center'})"); await pause(250);
      const layout = await win.webContents.executeJavaScript("(() => {const p=document.getElementById('settings-usage-details'),t=p.querySelector('table');return {fits:document.documentElement.scrollWidth<=window.innerWidth+1 && t.scrollWidth<=t.clientWidth+1,rows:t.tBodies[0].rows.length};})()");
      assert.ok(layout.fits); assert.equal(layout.rows, 2); result.layouts.push({ width, ...layout });
      fs.writeFileSync(path.join(artifactDirectory, `usage-settings-${width}.png`), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    }
    const empty = structuredClone(fixture); empty.session = null; empty.selection.threadId = null; empty.selection.mode = 'empty'; setFixture(empty); await pause(150);
    result.emptyClears = await win.webContents.executeJavaScript("document.getElementById('settings-usage-details').innerText.includes('尚无') && !document.getElementById('settings-usage-details').innerText.includes('子代理模型')");
    for (const key of ['scopeWorks', 'detailsWork', 'staleRejected', 'emptyClears']) assert.equal(result[key], true, key);
    return result;
  } finally { settings.update(previous); win.setBounds(bounds); setFixture(null); await pause(150); }
}
module.exports = { checkUsage };
