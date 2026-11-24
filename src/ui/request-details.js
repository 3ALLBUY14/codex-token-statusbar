'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const format = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未记录';
  const time = value => Number.isFinite(value) ? `${(value / 1000).toFixed(2)} s` : '未记录';
  let state, active = false, threadId, page = 0, generation = 0, signature = '';
  let expandedId = null;
  const inSettings = document.body.classList.contains('settings-page');
  const dateFilter = `<details class="request-date-filter">
      <summary>按日期筛选</summary>
      <div class="tool-filters request-dates">
        <label>开始日期 <input type="date" id="request-from"></label>
        <label>结束日期 <input type="date" id="request-to"></label>
      </div>
    </details>`;
  $('request-view').innerHTML = `
    <div class="request-controls">
      <label for="request-model">模型</label>
      <select id="request-model"><option value="">全部模型</option></select>
      ${inSettings ? dateFilter : '<button class="action-button request-filter-link" id="request-open-filters">日期筛选…</button>'}
    </div>
    <div class="request-toolbar">
      <p id="request-status" role="status"></p>
      <div class="pager" id="request-pager" hidden>
        <button class="action-button" id="request-prev" aria-label="上一页请求">‹</button>
        <span id="request-page" aria-live="polite"></span>
        <button class="action-button" id="request-next" aria-label="下一页请求">›</button>
      </div>
    </div>
    <button class="action-button" id="request-retry" hidden>重新读取</button>
    <div id="request-records"></div>`;
  $('request-open-filters')?.addEventListener('click', () => window.codexStatusbar.settings('requests'));

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function renderRecords(records) {
    if (!records.length) { $('request-records').replaceChildren(); return; }
    const turns = new Map(), table = node('table', undefined, 'request-table');
    table.setAttribute('aria-label', '逐模型请求');
    const header = table.createTHead().insertRow();
    for (const label of ['模型 / 时间', 'Token', '缓存率', '首 Token', '耗时']) {
      const cell = node('th', label); cell.scope = 'col'; header.append(cell);
    }
    const focusedId = document.activeElement.dataset.requestId;
    let nextFocus;
    for (const record of records) {
      if (!turns.has(record.turnId)) {
        const body = table.createTBody(), heading = body.insertRow();
        heading.className = 'request-group';
        const cell = node('th', record.turnId ? `轮次 · ${record.turnId.slice(0, 8)}` : '轮次未记录');
        cell.scope = 'rowgroup';
        cell.colSpan = 5;
        heading.append(cell);
        turns.set(record.turnId, body);
      }
      const body = turns.get(record.turnId), row = body.insertRow();
      row.className = 'request-row';
      const model = node('button', record.model, 'request-expander');
      model.type = 'button';
      model.dataset.requestId = record.id;
      const date = record.timestamp ? new Date(record.timestamp) : null;
      const stamp = node('time', date ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '时间未记录');
      if (date) { stamp.dateTime = record.timestamp; stamp.title = date.toLocaleString('zh-CN', { hour12: false }); }
      const identity = node('div', undefined, 'request-identity');
      identity.append(model, stamp);
      row.insertCell().append(identity);
      const totalCell = row.insertCell();
      totalCell.className = 'request-total';
      totalCell.textContent = format(record.usage.total_tokens);
      const cacheCell = row.insertCell();
      const { input_tokens: input, cached_input_tokens: cached } = record.usage;
      const cachePercent = Number.isFinite(cached) && input > 0 ? cached * 100 / input : null;
      cacheCell.className = 'request-cache';
      cacheCell.dataset.tone = cachePercent === null ? 'muted' : cachePercent >= 90 ? 'teal' : cachePercent >= 50 ? 'blue' : 'amber';
      cacheCell.append(node('span', cachePercent === null ? '—' : `${cachePercent.toFixed(1)}%`));
      if (cachePercent === null) cacheCell.title = '缓存率未记录';
      for (const value of [record.firstTokenMs, record.durationMs]) {
        const cell = row.insertCell();
        cell.textContent = Number.isFinite(value) ? time(value) : '—';
        if (!Number.isFinite(value)) { cell.title = '未记录'; cell.setAttribute('aria-label', '未记录'); }
      }
      const expanded = body.insertRow(), detail = expanded.insertCell();
      expanded.className = 'request-expanded';
      detail.colSpan = 5;
      const counts = node('dl', undefined, 'request-counts');
      const fields = [['输入', 'input_tokens'], ['缓存输入', 'cached_input_tokens'], ['输出', 'output_tokens'], ['推理输出', 'reasoning_output_tokens']];
      for (const [label, field] of fields) {
        const column = node('div');
        column.append(node('dt', label), node('dd', format(record.usage[field])));
        counts.append(column);
      }
      detail.append(counts);
      expanded.hidden = expandedId !== record.id;
      model.setAttribute('aria-expanded', String(!expanded.hidden));
      model.addEventListener('click', () => {
        const open = expanded.hidden;
        const previous = table.querySelector('button[aria-expanded="true"]');
        if (previous && previous !== model) {
          previous.setAttribute('aria-expanded', 'false');
          previous.closest('tr').nextElementSibling.hidden = true;
        }
        expanded.hidden = !open;
        expandedId = open ? record.id : null;
        model.setAttribute('aria-expanded', String(open));
      });
      if (focusedId === record.id) nextFocus = model;
    }
    $('request-records').replaceChildren(table);
    nextFocus?.focus({ preventScroll: true });
  }
  async function load() {
    if (!active) return;
    const model = $('request-model').value, start = $('request-from')?.value ?? '', end = $('request-to')?.value ?? '';
    const key = JSON.stringify([threadId, state?.usageRevision, model, start, end, page]);
    if (key === signature) return;
    signature = key;
    const request = ++generation;
    $('request-retry').hidden = true;
    if (!threadId || (start && end && start > end)) {
      $('request-records').replaceChildren();
      $('request-pager').hidden = true;
      $('request-status').textContent = threadId ? '结束日期需要等于或晚于开始日期。' : '进入有本地记录的聊天后即可查看请求。';
      return;
    }
    $('request-prev').disabled = true;
    $('request-next').disabled = true;
    $('request-status').textContent = '正在读取请求…';
    try {
      const result = await window.codexStatusbar.modelRequests(threadId, { model, start, end, page });
      if (request !== generation) return;
      if (!result) {
        $('request-records').replaceChildren();
        $('request-pager').hidden = true;
        $('request-status').textContent = '聊天已切换，等待新记录…';
        return;
      }
      const existing = [...$('request-model').options].slice(1).map(option => option.value);
      if (JSON.stringify(existing) !== JSON.stringify(result.models)) {
        $('request-model').replaceChildren(new Option('全部模型', ''), ...result.models.map(name => new Option(name, name)));
      }
      $('request-model').value = result.model;
      page = result.page;
      signature = JSON.stringify([threadId, state?.usageRevision, result.model, start, end, page]);
      renderRecords(result.records);
      $('request-pager').hidden = result.pages === 1;
      $('request-prev').disabled = page === 0;
      $('request-next').disabled = page + 1 >= result.pages;
      $('request-page').textContent = `${page + 1} / ${result.pages} 页`;
      const coverage = state.health.indexing ? ' · 本地日志索引中' : state.session?.accounting?.partial ? ' · 部分历史缺少请求明细' : '';
      const count = `${format(result.total)} 条已记录请求`;
      $('request-status').textContent = result.matches ? `${result.matches === result.total ? '' : `${format(result.matches)} 条匹配 / `}${count}${coverage}`
        : result.total ? '没有符合筛选条件的请求。' : `当前聊天暂无逐请求用量记录${coverage}。`;
    } catch {
      if (request !== generation) return;
      $('request-records').replaceChildren();
      $('request-pager').hidden = true;
      $('request-retry').hidden = false;
      $('request-status').textContent = '请求明细读取失败。';
    }
  }
  function reload() {
    signature = '';
    void load();
  }
  for (const id of ['request-model', 'request-from', 'request-to']) {
    $(id)?.addEventListener('change', () => { page = 0; reload(); });
  }
  $('request-prev').addEventListener('click', () => { expandedId = null; page--; reload(); });
  $('request-next').addEventListener('click', () => { expandedId = null; page++; reload(); });
  $('request-retry').addEventListener('click', reload);
  globalThis.requestPanel = {
    update(next, visible) {
      state = next;
      if (active && !visible) { generation++; signature = ''; }
      active = visible;
      const nextId = state?.session?.threadId ?? null;
      if (nextId !== threadId) {
        threadId = nextId;
        page = 0;
        expandedId = null;
        $('request-model').replaceChildren(new Option('全部模型', ''));
        $('request-records').replaceChildren();
        $('request-pager').hidden = true;
      }
      const chat = $('request-chat');
      if (chat) chat.textContent = threadId ? (state.selection.title || state.session.model || '当前聊天') : '暂无当前聊天';
      void load();
    },
  };
})();
