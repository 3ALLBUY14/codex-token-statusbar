'use strict';
(() => {
  const names = { task: '主任务', subagent: '子代理', review: '自动审查', unknown: '来源未记录' };
  const count = n => Number.isFinite(n) ? n.toLocaleString('zh-CN') : '未记录';
  function node(tag, value, className) { const n = document.createElement(tag); if (value !== undefined) n.textContent = value; if (className) n.className = className; return n; }
  globalThis.renderUsageDetails = (container, session) => {
    const data = session?.accounting, signature = JSON.stringify(data ?? null);
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature;
    const oldScope = container.querySelector('select')?.value ?? 'current';
    const focused = container.contains(document.activeElement);
    container.replaceChildren();
    if (!data) { container.append(node('p', '当前聊天尚无可展示的用量归属。', 'settings-note')); return; }
    const label = node('label', '统计范围', 'usage-scope');
    const scope = node('select'); scope.setAttribute('aria-label', '用量归属统计范围');
    scope.add(new Option('当前聊天', 'current')); scope.add(new Option(`含关联子任务（${data.relatedThreads} 个）`, 'related')); scope.value = oldScope;
    label.append(scope); container.append(label);
    const body = node('div'); container.append(body);
    function render() {
      const report = scope.value === 'related' ? data.related : data;
      body.replaceChildren();
      body.append(node('p', `${data.method === 'response' ? '逐请求记录优先，按响应标识去重' : '旧格式累计记录，模型归属不补猜'}。${report.partial ? '统计范围不完整或存在冲突，仅展示可核实记录。' : '以下为本机已记录范围，不等同于账单。'}`, 'settings-note'));
      body.append(node('p', `已记录用量 ${count(report.totals.total_tokens)} Token · 请求 ${count(report.requests)}`, 'usage-total'));
      const sources = node('div', undefined, 'usage-sources');
      for (const row of report.bySource) {
        const line = node('div'), pct = report.totals.total_tokens ? row.total_tokens * 100 / report.totals.total_tokens : 0;
        line.append(node('span', names[row.source] ?? names.unknown), node('strong', `${count(row.total_tokens)} · ${pct.toFixed(1)}%`)); sources.append(line);
      }
      body.append(sources);
      const wrap = node('div', undefined, 'usage-table-wrap'), table = node('table', undefined, 'usage-models');
      table.append(node('caption', '按模型拆分'));
      const header = node('tr'); for (const name of ['模型', '输入', '输出', '请求']) { const th = node('th', name); th.scope = 'col'; header.append(th); }
      const head = node('thead'); head.append(header); table.append(head);
      const rows = node('tbody');
      for (const row of [...report.byModel].sort((a, b) => b.total_tokens - a.total_tokens).slice(0, 30)) {
        const tr = node('tr'), model = node('th', row.model); model.scope = 'row';
        model.append(node('small', `缓存 ${count(row.cached_input_tokens)} · 推理 ${count(row.reasoning_output_tokens)}`));
        tr.append(model, node('td', count(row.input_tokens)), node('td', count(row.output_tokens)), node('td', count(row.requests))); rows.append(tr);
      }
      table.append(rows); wrap.append(table); body.append(wrap);
      if (report.byModel.length > 30) body.append(node('p', `显示用量最多的 30 个模型，总量包含其余 ${report.byModel.length - 30} 个模型。`, 'settings-note'));
      if (!report.byModel.length) body.append(node('p', '等待已记录用量。', 'settings-note'));
    }
    scope.addEventListener('change', render); render(); if (focused) scope.focus({ preventScroll: true });
  };
})();
