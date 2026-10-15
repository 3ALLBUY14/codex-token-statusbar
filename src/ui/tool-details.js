'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const count = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
  const duration = value => Number.isFinite(value) ? `${(value / 1000).toFixed(1)}s` : '未记录';
  const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  let state, signature = '', context = '', page = 0;
  const PAGE_SIZE = 20;
  function records(target, entries, running = false) {
    const existing = new Map([...target.children].map(row => [row.dataset.key, row]));
    const wanted = new Set();
    entries.forEach((record, index) => {
      const key = String(record.key ?? record.sequence);
      wanted.add(key);
      let row = existing.get(key);
      if (!row) {
        row = document.createElement('li'); row.dataset.key = key;
        const heading = document.createElement('div'); heading.className = 'tool-record-top';
        const name = document.createElement('strong'), status = document.createElement('span');
        status.className = 'tool-record-status'; heading.append(name, status);
        const metadata = document.createElement('p'); metadata.className = 'tool-record-meta'; row.append(heading, metadata);
      }
      text(row.querySelector('strong'), `${running ? '' : '#' + count(record.sequence) + ' '}${record.name ?? record.label}${record.name ? ' · ' + record.label : ''}`);
      const status = row.querySelector('span'); status.classList.toggle('failed', record.status === 'failed');
      text(status, running ? '执行中' : record.status === 'failed' ? '失败' : '已完成');
      const timestamp = record.timestamp ? new Date(record.timestamp).toLocaleString('zh-CN', { hour12: false }) : '时间未记录';
      const elapsed = record.timestamp ? Math.max(0, Date.now() - Date.parse(record.timestamp)) : null;
      text(row.querySelector('p'), running ? `开始于 ${timestamp} · 已运行 ${duration(elapsed)}` : `${timestamp} · 耗时 ${duration(record.durationMs)}${record.exitCode !== null && record.exitCode !== undefined ? ' · 退出码 ' + record.exitCode : ''}`);
      if (target.children[index] !== row) target.insertBefore(row, target.children[index] ?? null);
    });
    for (const row of [...target.children]) if (!wanted.has(row.dataset.key)) row.remove();
  }
  function render() {
    if (!state) return;
    const session = state.session, turn = $('tool-scope').value === 'turn';
    const failed = $('tool-failed-only').checked, category = $('tool-category').value;
    const query = $('tool-search').value.trim().toLocaleLowerCase();
    const stats = turn ? session?.turnToolUsage : session?.toolUsage;
    const nextContext = JSON.stringify([state.selection.threadId, turn, failed, category, query, $('tool-sort').value]);
    if (context !== nextContext) { page = 0; context = nextContext; }
    const running = (turn ? session?.turnRunningTools : session?.runningTools) ?? [];
    const nextSignature = JSON.stringify([state.selection, stats, running, session?.active, context, page, running.length ? Math.floor(Date.now() / 1000) : 0]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    const modes = { following: '跟随当前聊天', pinned: '已锁定聊天', recent: '最近活跃聊天', empty: '当前页面暂无聊天数据', ambiguous: '请先选择聊天', unbound: '等待聊天数据' };
    text($('tool-chat'), [modes[state.selection.mode], state.selection.title ?? session?.model].filter(Boolean).join(' · '));
    text($('tool-turn-option'), session?.active ? '本轮' : '上一轮');
    const summary = stats ? `${count(stats.total)} 次 · 失败 ${count(stats.failed)} 次` : '暂无调用数据';
    text($('tool-stats'), stats ? `${turn ? session.active ? '本轮' : '上一轮' : '会话累计'} ${summary} · 有耗时记录 ${count(stats.timed)} 次 / ${duration(stats.durationMs)}` : '当前范围暂无已完成的工具调用。');
    const groups = $('settings-tool-groups'), groupSignature = JSON.stringify(stats?.byType);
    if (groups.dataset.signature !== groupSignature) {
      groups.dataset.signature = groupSignature; groups.replaceChildren();
      for (const group of stats?.byType ?? []) {
        const row = document.createElement('tr');
        for (const value of [group.label, count(group.total), count(group.failed), count(group.timed), group.timed ? duration(group.durationMs) : '未记录']) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
        groups.append(row);
      }
    }
    const matches = record => (category === 'all' || record.type === category) && (!query || `${record.name ?? ''} ${record.label}`.toLocaleLowerCase().includes(query));
    const all = stats?.records ?? [];
    const visible = [...all].reverse().filter(record => matches(record) && (!failed || record.status === 'failed'));
    if ($('tool-sort').value === 'duration') visible.sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1));
    const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE)); page = Math.min(page, pages - 1);
    text($('tool-record-note'), `最近 ${all.length} 条 / 累计 ${count(stats?.total ?? 0)} 次；筛选仅作用于最近记录（最多 200 条）。`);
    records($('settings-tool-records'), visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));
    const pending = failed ? [] : running.filter(matches);
    $('running-heading').hidden = !pending.length;
    text($('running-heading'), `执行中 ${count(pending.length)} 项${pending.length > 20 ? '（展示前 20 项）' : ''}`);
    records($('settings-running-tools'), pending.slice(0, 20), true);
    text($('tool-page'), `${page + 1} / ${pages} 页 · ${visible.length} 条匹配`);
    $('tool-prev').disabled = page === 0; $('tool-next').disabled = page >= pages - 1;
    text($('tool-empty'), visible.length ? '' : failed ? '保留的记录中没有匹配的失败调用。' : category !== 'all' || query ? '没有匹配的完成记录。' : '暂无已完成的工具调用。');
  }
  for (const id of ['tool-scope', 'tool-category', 'tool-sort', 'tool-failed-only']) $(id).addEventListener('change', render);
  $('tool-search').addEventListener('input', render);
  $('tool-prev').addEventListener('click', () => { page--; render(); });
  $('tool-next').addEventListener('click', () => { page++; render(); });
  window.toolPanel = { update: next => { state = next; render(); }, refresh: render };
})();
