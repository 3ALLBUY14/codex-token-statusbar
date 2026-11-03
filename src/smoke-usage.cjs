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
    const switched = structuredClone(fixture);
    switched.session.model = '新模型 B'; switched.session.accounting.byModel.push({ model: '新模型 B', ...counts(2000, 3) });
    switched.session.accounting.unassignedTokens = 700;
    switched.session.accounting.byModel.push({ model: '历史未归属（累计记录）', input_tokens: 700, output_tokens: 0, cached_input_tokens: null, reasoning_output_tokens: null, total_tokens: 700, requests: null });
    switched.session.totals = { input_tokens: 3700, output_tokens: 200, cached_input_tokens: 1500, reasoning_output_tokens: 60, total_tokens: 3900 };
    switched.session.accounting.totals = { ...switched.session.totals };
    switched.session.accounting.activity = { days: Array.from({length:50},(_,i)=>{const d=new Date();d.setDate(d.getDate()-i*3);return{date:d.toLocaleDateString('sv-SE'),tokens:(i+1)*100}}), partial:false };
    setFixture(switched); await pause(150);
    const barBefore = await overlay.webContents.executeJavaScript("document.getElementById('session').textContent");
    await overlay.webContents.executeJavaScript("document.getElementById('tab-models').click(); document.querySelector('#model-picker button').click()"); await pause(100);
    result.modelPage = await overlay.webContents.executeJavaScript("document.getElementById('overview-panel').hidden && !document.getElementById('models-panel').hidden && document.getElementById('model-total').textContent==='2,100'");
    if (overlay.isMinimized()) overlay.restore(); overlay.showInactive(); await pause(150);
    fs.writeFileSync(path.join(artifactDirectory, 'model-current-page.png'), (await overlay.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await overlay.webContents.executeJavaScript("const b=[...document.querySelectorAll('#model-picker button')].find(b=>b.textContent==='测试模型 GPT · 长名称换行检查');b.click();b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));");
    result.modelKeyboard = await overlay.webContents.executeJavaScript("document.getElementById('model-total').textContent==='700' && document.getElementById('model-requests').textContent==='未记录'");
    setFixture(switched); await pause(100);
    result.modelSelectionPreserved = await overlay.webContents.executeJavaScript("document.getElementById('model-total').textContent==='700' && document.getElementById('tab-models').getAttribute('aria-selected')==='true'");
    result.modelBarUnchanged = barBefore === await overlay.webContents.executeJavaScript("document.getElementById('session').textContent");
    if (overlay.isMinimized()) overlay.restore(); overlay.showInactive(); await pause(150);
    fs.writeFileSync(path.join(artifactDirectory, 'model-pages.png'), (await overlay.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await overlay.webContents.executeJavaScript("(() => {document.getElementById('tab-activity').click();const b=[...document.querySelectorAll('.activity-days button')].at(-1);b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));})()");
    result.activityKeyboard = await overlay.webContents.executeJavaScript("document.getElementById('activity-panel').hidden===false && document.activeElement.classList.contains('activity-cell') && document.activeElement.getAttribute('aria-pressed')==='true'");
    result.activityGrid = await overlay.webContents.executeJavaScript("document.querySelectorAll('.activity-days button').length===365 && [...document.querySelectorAll('.activity-cell')].some(n=>n.dataset.level==='4') && document.querySelector('.activity-heading').textContent.includes('50 个')");
    result.activityFits = await overlay.webContents.executeJavaScript("document.querySelector('.activity-days').scrollWidth<=document.querySelector('.activity-days').clientWidth+1");
    fs.writeFileSync(path.join(artifactDirectory, 'activity-heatmap.png'), (await overlay.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await overlay.webContents.executeJavaScript("document.getElementById('tab-overview').click()"); setFixture(fixture); await pause(100);
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
    result.modelEmptyClears = await overlay.webContents.executeJavaScript("document.getElementById('model-picker').children.length===0 && document.getElementById('model-total').textContent==='—' && document.getElementById('overview-panel').hidden===false");
    for (const key of ['scopeWorks', 'detailsWork', 'staleRejected', 'emptyClears', 'modelPage', 'modelKeyboard', 'modelSelectionPreserved', 'modelBarUnchanged', 'modelEmptyClears', 'activityKeyboard', 'activityGrid', 'activityFits']) assert.equal(result[key], true, key);
    return result;
  } finally { settings.update(previous); win.setBounds(bounds); setFixture(null); await pause(150); }
}
module.exports = { checkUsage };
