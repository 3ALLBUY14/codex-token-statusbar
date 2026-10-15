'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { SettingsStore } = require('./settings.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function checkOpacity({ overlay, settingsWindow, settings, publish, artifactDirectory }) {
  const previous = settings.value.opacity;
  const ui = script => settingsWindow.webContents.executeJavaScript(script);
  const view = script => overlay.webContents.executeJavaScript(script);
  const opacity = () => view('Number(getComputedStyle(document.getElementById("bar")).opacity)');
  const input = value => ui(`(() => { const input = document.getElementById('opacity'); input.focus(); input.scrollIntoView({block:'center'}); input.value = '${value}'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  try {
    await view('document.getElementById("bar").classList.remove("pointer-near")');
    const before = fs.readFileSync(settings.filename, 'utf8');
    await input(65); await pause(250); publish(); await pause(250);
    assert.ok(Math.abs(await opacity() - 0.65) < 0.01);
    assert.equal(fs.readFileSync(settings.filename, 'utf8'), before);
    assert.equal(await view('Number(getComputedStyle(document.getElementById("details")).opacity)'), 1);
    await ui('document.getElementById("opacity").dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))'); await pause(250);
    assert.ok(Math.abs(await opacity() - previous) < 0.01);
    await input(20); await pause(250);
    await view('document.getElementById("bar").classList.add("pointer-near")'); await pause(250);
    assert.ok(await opacity() <= 0.201);
    await view('document.getElementById("bar").classList.remove("pointer-near")');
    await input(65); await ui('document.getElementById("opacity").dispatchEvent(new Event("change",{bubbles:true})); document.getElementById("opacity").blur()'); await pause(300);
    assert.equal(new SettingsStore(path.dirname(settings.filename)).value.opacity, 0.65);
    assert.ok(Math.abs(await opacity() - 0.65) < 0.01);
    fs.writeFileSync(path.join(artifactDirectory, 'opacity-settings.png'), (await settingsWindow.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(artifactDirectory, 'opacity-overlay.png'), (await overlay.webContents.capturePage()).toPNG());
    await input(85); await pause(250);
    const loaded = new Promise(resolve => settingsWindow.webContents.once('did-finish-load', resolve));
    settingsWindow.webContents.reload(); await loaded; publish(); await pause(350);
    assert.ok(Math.abs(await opacity() - 0.65) < 0.01);
    assert.equal(await ui('document.getElementById("opacity-value").textContent'), '65%');
    return { livePreview: true, previewNotSaved: true, dataRefreshKeptPreview: true, escapeCanceled: true, hoverNeverIncreasesOpacity: true, savedOnChange: true, detailsOpaque: true, reloadCanceledPreview: true, percentageRestored: true };
  } finally { settings.update({ opacity: previous }); publish(); await pause(200); }
}
module.exports = { checkOpacity };
