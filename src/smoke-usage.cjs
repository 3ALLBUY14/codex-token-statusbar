'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { ResponseLedger, buildUsageIndex } = require('./response-usage.cjs');
const { SettingsStore } = require('./settings.cjs');
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
    result.noticeOpensDetails = await overlay.webContents.executeJavaScript(`(() => {
      const chip = document.getElementById('state-note'), detail = document.getElementById('detail-explanation');
      if (chip.hidden || !chip.textContent.includes('用量不完整')) return false;
      chip.click();
      const opened = detail.open && document.getElementById('state-details').innerText.includes('历史记录不完整');
      detail.open = false;
      return opened;
    })()`);
    const switched = structuredClone(fixture);
    switched.session.model = '新模型 B'; switched.session.accounting.byModel.push({ model: '新模型 B', ...counts(2000, 3) });
    switched.session.accounting.unassignedTokens = 700;
    switched.session.accounting.byModel.push({ model: '历史未归属（累计记录）', input_tokens: 700, output_tokens: 0, cached_input_tokens: null, reasoning_output_tokens: null, total_tokens: 700, requests: null });
    switched.session.totals = { input_tokens: 3700, output_tokens: 200, cached_input_tokens: 1500, reasoning_output_tokens: 60, total_tokens: 3900 };
    switched.session.accounting.totals = { ...switched.session.totals };
    switched.session.accounting.activity = { days: Array.from({length:50},(_,i)=>{const d=new Date();d.setDate(d.getDate()-i*3);return{date:d.toLocaleDateString('sv-SE'),tokens:(i+1)*100}}), partial:false };
    const date = new Date();
    const today = date.toLocaleDateString('sv-SE');
    const olderDays = [2500, 1700, 3900, 800, 0, 2900].flatMap((tokens, index) => {
      if (!tokens) return [];
      const day = new Date(date);
      day.setDate(day.getDate() - index - 1);
      return [{ date: day.toLocaleDateString('sv-SE'), tokens, byModel: [{ model: '测试模型 GPT', tokens }] }];
    });
    switched.allActivity = { days: [{ date: today, tokens: 4600, byModel: [{ model: '新模型 B', tokens: 3000 }, { model: '模型未记录', tokens: 1600 }] }, ...olderDays], partial: true };
    const ledger = new ResponseLedger(), threadId = switched.session.threadId;
    ledger.feed({ type: 'session_meta', payload: { id: threadId } });
    for (let index = 0; index < 22; index++) {
      ledger.feed({ type: 'token_usage_record', timestamp: new Date(date.getTime() - index * 1000).toISOString(), payload: {
        thread_id: threadId, response_id: `response-${index}`, turn_id: index < 20 ? 'turn-1' : 'turn-2',
        model: index < 20 ? '新模型 B' : '测试模型 GPT', usage: counts(1000 + index * 2),
        duration_ms: index < 20 ? 1200 : undefined, time_to_first_token_ms: index < 20 ? 200 : undefined,
      } });
    }
    const requests = buildUsageIndex([{ ledger, accumulator: { id: threadId } }], []).groups.get(threadId);
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
    result.allActivity = await overlay.webContents.executeJavaScript(`(() => {
      const scope = document.getElementById('activity-scope'), period = document.getElementById('activity-period');
      scope.value = 'all'; scope.dispatchEvent(new Event('change'));
      period.querySelector('[data-days="7"]').click();
      const chart = document.getElementById('activity-chart');
      const readout = chart.querySelector('.activity-breakdown');
      return chart.querySelectorAll('.activity-point').length === 7 && readout.innerText.includes('4,600 Token')
        && readout.innerText.includes('3,000 Token') && readout.innerText.includes('模型未记录')
        && chart.querySelector('.activity-ranking').innerText.includes('模型用量排行');
    })()`);
    await pause(250);
    result.trendDrawn = await overlay.webContents.executeJavaScript(`(() => {
      const canvas = document.querySelector('.activity-canvas');
      if (!canvas?.width || !canvas.height) return false;
      return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 100);
    })()`);
    fs.writeFileSync(path.join(artifactDirectory, 'activity-global.png'), (await overlay.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    result.activityHoverMatchesDay = await overlay.webContents.executeJavaScript(`(() => {
      const points = document.querySelectorAll('.activity-point'), point = points[points.length - 2];
      const breakdown = document.querySelector('.activity-breakdown');
      point.dispatchEvent(new MouseEvent('mouseenter'));
      const hovered = breakdown.innerText.includes('2,500 Token') && breakdown.innerText.includes('测试模型 GPT') && !breakdown.innerText.includes('新模型 B');
      point.dispatchEvent(new MouseEvent('mouseleave'));
      return hovered && breakdown.innerText.includes('新模型 B');
    })()`);
    await overlay.webContents.executeJavaScript("document.getElementById('tab-overview').click()");
    setFixture(switched, requests);
    await overlay.webContents.executeJavaScript("document.getElementById('tab-requests').click()");
    await pause(180);
    result.overlayRequests = await overlay.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.request-row'), button = row?.querySelector('button');
      button?.click();
      return document.getElementById('tab-requests').getAttribute('aria-selected') === 'true'
        && document.querySelectorAll('.request-row').length === 20
        && button?.getAttribute('aria-expanded') === 'true' && row.nextElementSibling.innerText.includes('缓存输入')
        && row.querySelector('.request-cache').textContent === '50.0%'
        && document.getElementById('details').scrollWidth <= document.getElementById('details').clientWidth + 1;
    })()`);
    await pause(120);
    fs.writeFileSync(path.join(artifactDirectory, 'overlay-request-table.png'), (await overlay.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await overlay.webContents.executeJavaScript("document.getElementById('request-open-filters').click()");
    await pause(150);
    result.requestFilterShortcut = await win.webContents.executeJavaScript("document.getElementById('tab-requests').getAttribute('aria-selected') === 'true' && document.getElementById('request-from').closest('details').open && document.activeElement.id === 'request-from'");
    await overlay.webContents.executeJavaScript("document.getElementById('tab-overview').click()");
    win.setSize(460, 720);
    if (win.isMinimized()) win.restore();
    win.showInactive();
    await win.webContents.executeJavaScript("document.getElementById('tab-requests').focus(); document.getElementById('tab-requests').click()");
    await pause(180);
    result.requestPage = await win.webContents.executeJavaScript("document.querySelectorAll('.request-row').length === 20 && document.getElementById('request-page').textContent === '1 / 2 页' && document.getElementById('request-records').innerText.includes('1.20 s')");
    await win.webContents.executeJavaScript("document.getElementById('request-next').click()");
    await pause(150);
    result.requestPagination = await win.webContents.executeJavaScript("document.querySelectorAll('.request-row').length === 2 && document.querySelector('.request-row td:last-child').title === '未记录'");
    await win.webContents.executeJavaScript(`(() => {
      const model = document.getElementById('request-model');
      model.value = '新模型 B'; model.dispatchEvent(new Event('change'));
    })()`);
    await pause(150);
    result.requestFilter = await win.webContents.executeJavaScript("document.getElementById('request-status').textContent.includes('20 条匹配 / 22') && document.getElementById('request-pager').hidden && document.documentElement.scrollWidth <= window.innerWidth + 1");
    fs.writeFileSync(path.join(artifactDirectory, 'model-request-details.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await win.webContents.executeJavaScript(`(() => {
      const date = document.getElementById('request-to');
      date.value = '2000-01-01'; date.dispatchEvent(new Event('change'));
    })()`);
    await pause(120);
    result.requestDateFilter = await win.webContents.executeJavaScript("!document.querySelector('.request-row') && document.getElementById('request-status').textContent.includes('没有符合')");
    await win.webContents.executeJavaScript(`(() => {
      document.getElementById('tab-metrics').click();
      const check = document.querySelector('[data-setting=showTtft]');
      if (!check.checked) check.click();
      const up = check.closest('li').querySelector('button'); up.focus(); up.click();
    })()`);
    await pause(180);
    result.metricReorder = await win.webContents.executeJavaScript("document.querySelectorAll('#metric-order input')[1].dataset.setting === 'showTtft' && document.activeElement.getAttribute('aria-label') === '上移首 Token 延迟'");
    result.ttftVisible = await overlay.webContents.executeJavaScript("document.getElementById('ttft').textContent === '2.0s' && document.querySelectorAll('#metrics .metric')[1].dataset.metric === 'ttft' && !document.getElementById('ttft').closest('[data-metric]').hidden");
    const reloaded = new SettingsStore(path.dirname(settings.filename));
    result.metricOrderSaved = reloaded.value.metricOrder[1] === 'ttft' && reloaded.value.showTtft;
    fs.writeFileSync(path.join(artifactDirectory, 'metric-order-settings.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await win.webContents.executeJavaScript(`(() => {
      const source = document.querySelector('[data-setting=showTtft]').closest('li');
      const target = document.querySelector('[data-setting=showSpeed]').closest('li');
      const handle = source.querySelector('[draggable]');
      const transfer = new DataTransfer();
      for (const [type, element] of [['dragstart', handle], ['dragover', target], ['drop', target], ['dragend', handle]]) {
        element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }
    })()`);
    await pause(180);
    result.metricDrag = await overlay.webContents.executeJavaScript("document.querySelector('#metrics .metric').dataset.metric === 'ttft'");
    await win.webContents.executeJavaScript("document.getElementById('tab-chat').click()");
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
    for (const [key, value] of Object.entries(result)) if (key !== 'layouts') assert.equal(value, true, JSON.stringify(result));
    return result;
  } finally { settings.update(previous); win.setBounds(bounds); setFixture(null); await pause(150); }
}
module.exports = { checkUsage };
