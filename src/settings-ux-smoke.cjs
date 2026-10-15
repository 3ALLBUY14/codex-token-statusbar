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
      const collapsed = [...document.querySelectorAll('.detail-extra')].every(item => !item.open);
      const primarySummary = outer.innerText.includes('会话累计') && outer.innerText.includes('86,420') && !outer.innerText.includes('输入 Token');
      document.querySelector('#detail-tokens > summary').click();
      const tokenDetails = document.getElementById('detail-tokens').open && outer.innerText.includes('输入 Token');
      document.querySelector('#detail-tools > summary').click();
      const toolsReachable = outer.innerText.includes('命令执行');
      return { summaryCollapsed: collapsed, primarySummary, tokenDetails, toolsReachable, cPanelStayedOpen: outer.classList.contains('open') };
    })()`);
    publish(); await pause(150);
    result.refreshPreservedFold = await view('document.getElementById("detail-tokens").open');
    await view('document.querySelectorAll(".detail-extra").forEach(item => item.open = false)');
    await ui('document.querySelector("#advanced-position > summary").click()'); publish(); await pause(100);
    result.advancedPositionReachable = await ui('document.getElementById("advanced-position").open && document.getElementById("offsetX").getBoundingClientRect().height > 0');
    await ui('document.querySelector("#advanced-position > summary").click(); window.scrollTo(0, 0)');
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
