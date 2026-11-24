'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { SettingsStore } = require('./settings.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function checkSettingsUx({ win, overlay, settings, publish, artifactDirectory }) {
  const previous = { ...settings.value }, originalUpdate = settings.update;
  const ui = script => win.webContents.executeJavaScript(script);
  const view = script => overlay.webContents.executeJavaScript(script);
  const capture = async filename => {
    if (win.isMinimized()) win.restore();
    win.showInactive(); await pause(200);
    try { fs.writeFileSync(path.join(artifactDirectory, filename), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG()); }
    catch (error) { throw new Error('Settings screenshot failed: ' + filename + ' visible=' + win.isVisible() + ' minimized=' + win.isMinimized() + ' bounds=' + JSON.stringify(win.getBounds()) + ' cause=' + error.message); }
  };
  try {
    if (win.isMaximized()) win.unmaximize(); win.setSize(560, 720); await pause(200);
    assert.equal(await ui('document.getElementById("advanced-position").open'), false);
    const result = await view(`(() => {
      const outer = document.getElementById('details');
      const toggle=document.querySelector('[data-action=details]');if(toggle.getAttribute('aria-expanded')!=='true')toggle.click();
      document.getElementById('tab-overview').click();
      const original = { ...snapshot, delivery: null };
      render({ ...original, selection: { ...original.selection, title: 'codex-token-usage-statusbar' } });
      const heading = document.getElementById('chat-title');
      const wordsCapitalized = heading.textContent === 'Codex-Token-Usage-Statusbar' && heading.title === heading.textContent;
      render(original);
      const collapsed = [...document.querySelectorAll('.detail-extra')].every(item => !item.open);
      const primarySummary = outer.innerText.includes('会话累计') && outer.innerText.includes('86,420') && !outer.innerText.includes('输入 Token');
      const ringMatchesContext = document.querySelector('.context-ring').style.getPropertyValue('--context-fill').startsWith('44.27')
        && document.getElementById('context-detail-percent').textContent === '44.3%';
      const scale = document.getElementById('context-meter');
      const contextLegend = !document.getElementById('context-legend').hidden
        && scale.style.getPropertyValue('--warning-at') === '70%' && scale.style.getPropertyValue('--critical-at') === '85%';
      const parts = document.getElementById('context-parts');
      const contextParts = !parts.hidden && parts.children.length === 4 && parts.textContent.includes('75,600')
        && scale.querySelectorAll('#context-meter-fill > span').length === 4;
      const quotaList = document.getElementById('quota-windows');
      const quotaUsage = [...quotaList.querySelectorAll('[role="meter"]')].map(meter => meter.getAttribute('aria-valuenow')).join(',');
      const quotaMeters = quotaUsage === '82,25' && quotaList.textContent.includes('剩余 75%');
      const shownQuota = snapshot.quota;
      renderQuota({ ...shownQuota, plan: 'pro', source: 'official' });
      const proQuotaHidden = quotaList.querySelectorAll('[role="meter"]').length === 1
        && quotaList.textContent.includes('周额度') && !quotaList.textContent.includes('5 小时额度');
      renderQuota(shownQuota);
      const visualTones = [...document.querySelectorAll('.overview-kpis .monitor-tile')].map(tile => getComputedStyle(tile).getPropertyValue('--tone'));
      const distinctCards = new Set(visualTones).size === 4 && visualTones.every(Boolean);
      document.querySelector('#detail-tokens > summary').click();
      const tokenDetails = document.getElementById('detail-tokens').open && outer.innerText.includes('输入 Token');
      const tokenStack = document.getElementById('token-compose');
      const tokenBreakdown = !tokenStack.hidden && Math.abs([...tokenStack.querySelectorAll('.token-stack i')].reduce((sum, i) => sum + parseFloat(i.style.width), 0) - 100) < .001
        && document.getElementById('token-fold-summary').textContent === '1.84M Token';
      document.querySelector('#detail-tools > summary').click();
      const toolsReachable = outer.innerText.includes('命令执行');
      return { wordsCapitalized, summaryCollapsed: collapsed, primarySummary, ringMatchesContext, contextLegend, contextParts, quotaMeters, proQuotaHidden, distinctCards, tokenDetails, tokenBreakdown, toolsReachable, cPanelStayedOpen: outer.classList.contains('open') };
    })()`);
    publish(); await pause(150);
    result.refreshPreservedFold = await view('document.getElementById("detail-tokens").open');
    await view('document.getElementById("detail-tokens").scrollIntoView({block:"start"})');
    await pause(150);
    fs.writeFileSync(path.join(artifactDirectory, 'expanded-disclosures.png'), (await overlay.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await view('document.querySelectorAll(".detail-extra").forEach(item => item.open = false)');
    win.setSize(710, 760); await pause(180);
    await ui('document.getElementById("tab-display").click()');
    await capture('settings-appearance-wide.png');
    const wideSettingsReady = `(() => {
      const nav = document.querySelector('.settings-navigation').getBoundingClientRect();
      const links = document.querySelector('.settings-links').getBoundingClientRect();
      const page = document.getElementById('settings-scroll').getBoundingClientRect();
      const preview = document.getElementById('appearance-capsule');
      return document.querySelector('.settings-tabs').getAttribute('aria-orientation') === 'vertical'
        && nav.right <= page.left + 1 && Math.abs(nav.bottom - links.top) < 1 && Math.abs(links.bottom - page.bottom) < 1
        && preview.getBoundingClientRect().width > 0 && document.getElementById('appearance-metrics').children.length > 0;
    })()`;
    for (let attempt = 0; attempt < 8; attempt++) {
      result.wideSettings = await ui(wideSettingsReady);
      if (result.wideSettings) break;
      await pause(75);
    }
    await ui('document.querySelector(\'[data-choice-for=scale] button[data-value="1.15"]\').click()'); await pause(150);
    result.segmentedScaleSaved = settings.value.scale === 1.15 && await ui('document.querySelector(\'[data-choice-for=scale] button[data-value="1.15"]\').getAttribute("aria-pressed") === "true"');
    settings.update({ scale: previous.scale }); publish();
    await ui('document.getElementById("tab-display").focus(); document.getElementById("tab-display").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));');
    result.verticalTabs = await ui('document.activeElement.id === "tab-metrics" && !document.getElementById("pane-metrics").hidden');
    win.setSize(560, 720); await pause(150);
    await ui('document.getElementById("tab-position").click(); document.querySelector("#advanced-position > summary").click()'); publish(); await pause(100);
    result.advancedPositionReachable = await ui('document.getElementById("advanced-position").open && document.getElementById("offsetX").getBoundingClientRect().height > 0');
    await ui('document.querySelector("#advanced-position > summary").click(); document.getElementById("tab-metrics").click()');
    const before = fs.readFileSync(settings.filename, 'utf8'), expected = !settings.value.showCache;
    settings.update = function(patch) { if (Object.hasOwn(patch, 'showCache')) throw Object.assign(new Error('test-denied'), { code: 'EACCES' }); return originalUpdate.call(this, patch); };
    await ui('document.querySelector("[data-setting=showCache]").click()'); await pause(200);
    result.failureVisible = await ui('document.getElementById("save-feedback").dataset.state === "error" && !document.getElementById("retry-save").hidden && document.getElementById("save-status").textContent.includes("EACCES")');
    assert.equal(fs.readFileSync(settings.filename, 'utf8'), before);
    publish(); await pause(100);
    result.failureSurvivedRefresh = await ui('document.getElementById("save-feedback").dataset.state === "error"');
    await capture('settings-save-error.png');
    settings.update = originalUpdate;
    await ui('document.getElementById("retry-save").click()'); await pause(200);
    result.retrySaved = settings.value.showCache === expected && new SettingsStore(path.dirname(settings.filename)).value.showCache === expected;
    result.savedFeedback = await ui('document.getElementById("save-status").textContent === "已保存" && document.getElementById("retry-save").hidden');
    await capture('settings-save-success.png');
    await pause(2600);
    result.successSettled = await ui('document.getElementById("save-feedback").dataset.state === "idle"');
    settings.update = function(patch) { if (Object.hasOwn(patch, 'displayPositions')) throw Object.assign(new Error('test-denied'), { code: 'EACCES' }); return originalUpdate.call(this, patch); };
    await ui('document.getElementById("restore-position").click()'); await pause(150);
    result.restoreFailureVisible = await ui('document.getElementById("save-feedback").dataset.state === "error" && !document.getElementById("retry-save").hidden');
    settings.update = originalUpdate;
    await ui('document.getElementById("retry-save").click()'); await pause(150);
    result.restoreRetried = settings.value.offsetX === 0 && settings.value.displayPositions.length === 0 && await ui('document.getElementById("save-status").textContent === "已保存"');
    await ui('document.getElementById("tab-tools").click()'); await pause(100);
    result.toolsImmediatelyVisible = await ui('document.getElementById("tool-details").tagName === "DIV" && document.getElementById("settings-tool-records").getBoundingClientRect().height > 0 && !document.getElementById("tool-classification").open');
    result.filtersBeforeRecords = await ui('document.getElementById("tool-search").getBoundingClientRect().top < document.getElementById("settings-tool-records").getBoundingClientRect().top');
    await ui('document.querySelector("#tool-classification > summary").click()');
    result.classificationReachable = await ui('document.querySelector(".tool-table").getBoundingClientRect().height > 0');
    await ui('document.querySelector("#tool-classification > summary").click(); document.getElementById("tab-display").click()');
    if (Object.values(result).some(value => !value)) throw new Error('Settings UX check failed: ' + JSON.stringify(result));
    return result;
  } finally { settings.update = originalUpdate; settings.update(previous); publish(); }
}
module.exports = { checkSettingsUx };
