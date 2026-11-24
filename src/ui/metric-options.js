'use strict';
(() => {
  const metrics = [
    { id: 'speed', setting: 'showSpeed', label: '平均输出速度' },
    { id: 'context', setting: 'showContext', label: '上下文占用' },
    { id: 'ttft', setting: 'showTtft', label: '首 Token 延迟' },
    { id: 'session', setting: 'showSession', label: '会话累计 Token' },
    { id: 'turn', setting: 'showTurn', label: '本轮 / 上轮 Token' },
    { id: 'today', setting: 'showToday', label: '今日 Token' },
    { id: 'cache', setting: 'showCache', label: '缓存命中率' },
    { id: 'tools', setting: 'showTools', label: '工具调用' },
  ];
  const defaultOrder = Object.freeze(metrics.map(metric => metric.id));
  function orderedIds(order) {
    if (!Array.isArray(order)) return defaultOrder;
    const known = order.slice(0, defaultOrder.length).filter(id => defaultOrder.includes(id));
    return [...new Set([...known, ...defaultOrder])];
  }
  const options = { metrics, defaultOrder, orderedIds };
  if (typeof module !== 'undefined') module.exports = options;
  else globalThis.MetricOptions = options;
})();
