'use strict';
(() => {
  const dayKey = date => date.toLocaleDateString('sv-SE');
  const count = value => value.toLocaleString('zh-CN');
  function activityDays(rows, end = dayKey(new Date()), length = 365) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw Error('Invalid activity date');
    const last = new Date(end + 'T12:00:00');
    if (!Number.isFinite(last.getTime()) || dayKey(last) !== end) throw Error('Invalid activity date');
    const byDate = new Map();
    for (const row of rows ?? []) {
      if (typeof row.date === 'string' && Number.isSafeInteger(row.tokens) && row.tokens >= 0) byDate.set(row.date, row);
    }
    const first = new Date(last);
    first.setDate(first.getDate() - length + 1);
    const days = [];
    let maximum = 0, total = 0, active = 0;
    for (const date = new Date(first); date <= last; date.setDate(date.getDate() + 1)) {
      const key = dayKey(date), row = byDate.get(key), tokens = row?.tokens ?? 0;
      maximum = Math.max(maximum, tokens);
      total += tokens;
      active += Number(tokens > 0);
      days.push({ date: key, tokens, byModel: row?.byModel ?? [], recorded: Boolean(row), month: date.getMonth() + 1, monthStart: date.getDate() === 1 });
    }
    for (const day of days) {
      day.level = day.tokens ? Math.ceil(day.tokens / maximum * 4) : 0;
    }
    return { days, total, active, leading: first.getDay(), weeks: Math.ceil((first.getDay() + length) / 7) };
  }
  if (typeof module !== 'undefined') { module.exports = { activityDays }; return; }
  const trendObservers = new WeakMap();

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function modelTotalsFor(days) {
    const totals = new Map();
    for (const day of days) {
      for (const { model, tokens } of day.byModel) totals.set(model, (totals.get(model) ?? 0) + tokens);
    }
    return [...totals].sort((a, b) => b[1] - a[1]);
  }
  function appendModelTotals(list, entries, total, tones) {
    list.replaceChildren();
    for (const [model, tokens] of entries) {
      const row = node('div');
      row.dataset.tone = tones.get(model) ?? 'muted';
      row.append(node('span', model, 'semantic-key'), node('strong', `${count(tokens)} Token`));
      if (total > 0) {
        const meter = node('span', undefined, 'monitor-progress'), bar = node('i');
        const percent = Math.min(100, tokens * 100 / total);
        meter.title = `占所选时段 ${percent.toFixed(1)}%`;
        meter.setAttribute('aria-hidden', 'true');
        bar.style.width = `${percent}%`;
        meter.append(bar);
        row.append(meter);
      }
      list.append(row);
    }
    list.hidden = !entries.length;
  }
  function metricTile(label, value, caption, tone, icon) {
    const tile = node('div');
    tile.className = 'monitor-tile';
    tile.dataset.tone = tone;
    const title = node('span', label), symbol = node('i', undefined, 'ui-icon');
    symbol.dataset.icon = icon;
    symbol.setAttribute('aria-hidden', 'true');
    title.append(symbol);
    tile.append(title, node('strong', value));
    if (caption) tile.append(node('small', caption));
    return tile;
  }
  function calendar(container, data) {
    const scroller = node('div', undefined, 'activity-scroll');
    const content = node('div', undefined, 'activity-calendar');
    const months = node('div', undefined, 'activity-months');
    months.style.gridTemplateColumns = `repeat(${data.weeks},minmax(0,1fr))`;
    const nextMonth = data.days.findIndex((day, index) => index > 0 && day.monthStart);
    const roomForPartialMonth = data.leading + nextMonth >= 21;
    data.days.forEach((day, index) => {
      const week = Math.floor((data.leading + index) / 7);
      if ((day.monthStart || (index === 0 && roomForPartialMonth)) && week <= data.weeks - 3) {
        const label = node('span', `${day.month}月`);
        label.style.gridColumn = `${week + 1}/span 3`;
        months.append(label);
      }
    });
    const board = node('div', undefined, 'activity-board'), labels = node('div', undefined, 'activity-weekdays');
    for (const [label, row] of [['一', 2], ['三', 4], ['五', 6]]) {
      const item = node('span', label);
      item.style.gridRow = String(row);
      labels.append(item);
    }
    const grid = node('div', undefined, 'activity-days');
    grid.style.gridTemplateColumns = `repeat(${data.weeks},minmax(0,1fr))`;
    for (let i = 0; i < data.leading; i++) grid.append(node('span', undefined, 'activity-blank'));
    board.append(labels, grid);
    content.append(months, board);
    scroller.append(content);
    container.append(scroller);
    return grid;
  }
  function paintTrend(canvas, days, maximum, active) {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const dpr = window.devicePixelRatio || 1;
    const width = bounds.width, height = bounds.height, baseline = height - 6;
    const pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const color = getComputedStyle(canvas).color;
    const muted = getComputedStyle(canvas).getPropertyValue('--color-foreground-subtlest');
    const points = days.map((day, index) => ({
      x: (index + .5) * width / days.length,
      y: baseline - (maximum ? day.tokens / maximum : 0) * (baseline - 8),
      recorded: day.recorded,
    }));
    const fill = ctx.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, color);
    fill.addColorStop(1, 'transparent');
    function drawSeries(series) {
      if (series.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(series[0].x, series[0].y);
      for (let index = 1; index < series.length; index++) {
        const previous = series[index - 1], next = series[index], middle = (previous.x + next.x) / 2;
        ctx.bezierCurveTo(middle, previous.y, middle, next.y, next.x, next.y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.9;
      ctx.stroke();
      ctx.lineTo(series.at(-1).x, baseline);
      ctx.lineTo(series[0].x, baseline);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.globalAlpha = .24;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    let series = [];
    for (const point of points) {
      if (point.recorded) series.push(point);
      else { drawSeries(series); series = []; }
    }
    drawSeries(series);
    points.forEach((point, index) => {
      if (index === active) {
        ctx.beginPath();
        ctx.moveTo(point.x, 2);
        ctx.lineTo(point.x, baseline);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = muted;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.arc(point.x, point.y, index === active ? 3.7 : point.recorded ? 2.15 : 1.15, 0, Math.PI * 2);
      ctx.fillStyle = point.recorded ? color : muted;
      ctx.fill();
    });
  }
  globalThis.renderActivityGrid = (container, activity, scopeKey, scope, length) => {
    const end = dayKey(new Date()), light = document.documentElement.classList.contains('light');
    const signature = JSON.stringify([scopeKey, length, end, light, activity]);
    if (container.dataset.signature === signature) return;
    const hadFocus = container.contains(document.activeElement) && document.activeElement.matches('[data-activity-day]');
    const lastSelection = container.dataset.scopeKey === scopeKey ? container.dataset.selected : null;
    const rankingOpen = container.querySelector('.activity-ranking details')?.open;
    container.dataset.signature = signature;
    container.dataset.scopeKey = scopeKey;
    trendObservers.get(container)?.disconnect();
    trendObservers.delete(container);
    container.replaceChildren();
    const data = activityDays(activity?.days, end, length), year = length === 365;
    const period = year ? '近一年' : `近 ${length} 天`;
    const peak = data.days.reduce((highest, day) => day.tokens > highest.tokens ? day : highest, data.days[0]);
    const entries = modelTotalsFor(data.days), palette = ['blue', 'violet', 'teal', 'amber'];
    const tones = new Map(entries.map(([model], index) => [model, /未记录|未归属/.test(model) ? 'muted' : palette[index % palette.length]]));
    const cards = node('div', undefined, 'monitor-kpis activity-heading');
    cards.append(metricTile(`${period}用量`, count(data.total), 'Token', 'blue', 'stack'),
      metricTile('活跃日', `${data.active} 个`, null, 'teal', 'bars'),
      metricTile('单日峰值', peak.tokens ? count(peak.tokens) : '—', peak.tokens ? peak.date.slice(5) : null, 'violet', 'bolt'));
    const plot = node('section', undefined, 'monitor-section');
    const surface = node('div', undefined, year ? 'activity-surface' : 'activity-surface activity-surface-trend');
    const heading = node('div', undefined, 'activity-plot-heading');
    heading.append(node('h2', year ? '用量热力图' : '用量趋势'));
    if (!year) {
      const legend = node('div', undefined, 'trend-legend');
      for (const [label, tone] of [['有记录', 'blue'], ['无记录', 'muted']]) {
        const key = node('span', label, 'semantic-key');
        key.dataset.tone = tone;
        legend.append(key);
      }
      heading.append(legend);
    }
    plot.append(heading);
    surface.append(plot);
    container.append(cards, surface);
    const grid = year ? calendar(plot, data) : node('div', undefined, 'activity-trend');
    let canvas;
    if (!year) {
      grid.style.gridTemplateColumns = `repeat(${length},minmax(0,1fr))`;
      canvas = node('canvas', undefined, 'activity-canvas');
      canvas.setAttribute('aria-hidden', 'true');
      grid.append(canvas);
      const frame = node('div', undefined, 'activity-trend-frame');
      const ticks = node('div', undefined, 'activity-ticks');
      ticks.append(node('span', peak.tokens ? count(peak.tokens) : ''), node('span', peak.tokens > 1 ? count(Math.floor(peak.tokens / 2)) : ''), node('span', '0'));
      frame.append(ticks, grid);
      plot.append(frame);
    }
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', `${scope}${period}每日 Token 用量`);

    const readout = node('p', undefined, 'activity-readout'), modelTotals = node('div', undefined, 'activity-model-totals');
    const description = day => `${day.date} · ${day.recorded ? `${count(day.tokens)} Token` : '无本地记录'}`;
    readout.setAttribute('role', 'status');
    const cells = [];
    let selected = data.days.findIndex(day => day.date === lastSelection);
    if (selected < 0) selected = data.days.length - 1;
    let illustrated = selected;
    function showDay(index) {
      const day = data.days[index];
      readout.textContent = description(day);
      appendModelTotals(modelTotals, modelTotalsFor([day]), undefined, tones);
      illustrated = index;
      if (canvas) paintTrend(canvas, data.days, peak.tokens, illustrated);
    }
    function select(index, focus = false) {
      for (let i = 0; i < cells.length; i++) {
        cells[i].tabIndex = i === index ? 0 : -1;
        cells[i].setAttribute('aria-pressed', String(i === index));
      }
      const day = data.days[index];
      selected = index;
      container.dataset.selected = day.date;
      showDay(index);
      if (focus) cells[index].focus({ preventScroll: true });
      const scroller = cells[index].closest('.activity-scroll');
      if (scroller) {
        const cell = cells[index].getBoundingClientRect(), view = scroller.getBoundingClientRect();
        if (cell.left < view.left) scroller.scrollLeft += cell.left - view.left - 2;
        if (cell.right > view.right) scroller.scrollLeft += cell.right - view.right + 2;
      }
    }
    data.days.forEach((day, index) => {
      const button = node('button', undefined, year ? 'activity-cell' : 'activity-point');
      button.type = 'button';
      button.dataset.activityDay = day.date;
      button.dataset.level = String(day.level);
      button.title = description(day);
      button.setAttribute('aria-label', description(day));
      button.addEventListener('click', () => select(index));
      button.addEventListener('focus', () => { if (selected !== index) select(index); });
      button.addEventListener('mouseenter', () => showDay(index));
      button.addEventListener('mouseleave', () => showDay(selected));
      button.addEventListener('keydown', event => {
        const step = year ? 7 : 1;
        const shifts = { ArrowLeft: -step, ArrowRight: step, ArrowUp: -1, ArrowDown: 1 };
        let next = index + (shifts[event.key] ?? 0);
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = data.days.length - 1;
        else if (!Object.hasOwn(shifts, event.key)) return;
        event.preventDefault();
        select(Math.max(0, Math.min(data.days.length - 1, next)), true);
      });
      cells.push(button);
      grid.append(button);
    });
    if (year) {
      const legend = node('div', undefined, 'activity-legend');
      legend.append(node('span', '每日 Token'), node('span', '少'));
      for (let level = 0; level <= 4; level++) {
        const swatch = node('i', undefined, 'activity-cell');
        swatch.dataset.level = String(level);
        legend.append(swatch);
      }
      legend.append(node('span', '多'));
      plot.append(legend);
    } else {
      const axis = node('div', undefined, 'activity-axis');
      axis.append(node('span', data.days[0].date), node('span', data.days.at(-1).date));
      plot.append(axis);
    }
    const breakdown = node('div', undefined, 'activity-breakdown');
    breakdown.append(readout, modelTotals);
    plot.append(breakdown);
    const ranking = node('section', undefined, 'monitor-section activity-ranking');
    const rankingTotals = node('div', undefined, 'activity-model-totals');
    appendModelTotals(rankingTotals, entries.slice(0, 3), data.total, tones);
    if (entries.length) {
      ranking.append(node('h2', '模型用量排行'), rankingTotals);
      if (entries.length > 3) {
        const more = node('details'), remaining = node('div', undefined, 'activity-model-totals');
        appendModelTotals(remaining, entries.slice(3), data.total, tones);
        more.append(node('summary', `查看其余 ${entries.length - 3} 个模型`), remaining);
        more.open = Boolean(rankingOpen);
        ranking.append(more);
      }
      surface.classList.add('has-ranking');
      surface.append(ranking);
    }
    if (activity?.partial) {
      const note = node('p', '部分历史未纳入', 'settings-note semantic-key');
      note.dataset.tone = 'amber';
      note.title = '日期统计仅包含可归属到具体日期的日志用量。';
      container.append(note);
    }
    if (canvas) {
      const observer = new ResizeObserver(() => paintTrend(canvas, data.days, peak.tokens, illustrated));
      observer.observe(grid);
      trendObservers.set(container, observer);
    }
    select(selected, hadFocus);
  };
})();
