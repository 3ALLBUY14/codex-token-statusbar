'use strict';
(() => {
  const dayKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  function activityDays(rows, end = dayKey(new Date())) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw Error('Invalid activity date');
    const last = new Date(end + 'T12:00:00'); if (!Number.isFinite(last.getTime()) || dayKey(last) !== end) throw Error('Invalid activity date');
    const counts = new Map();
    for (const row of rows ?? []) if (typeof row.date === 'string' && Number.isSafeInteger(row.tokens) && row.tokens >= 0) counts.set(row.date, row.tokens);
    const first = new Date(last); first.setDate(first.getDate() - 364);
    const days = []; let maximum = 0, total = 0, active = 0;
    for (let i = 0; i < 365; i++) { const date = new Date(first); date.setDate(first.getDate()+i); const key = dayKey(date), tokens = counts.get(key) ?? 0; maximum = Math.max(maximum, tokens); total += tokens; active += tokens > 0 ? 1 : 0; days.push({ date:key,tokens,recorded:counts.has(key),weekday:date.getDay(),month:date.getMonth()+1,monthStart:date.getDate()===1 }); }
    for (const day of days) day.level = day.tokens === 0 ? 0 : Math.max(1, Math.ceil(day.tokens / maximum * 4));
    return { days, total, active, leading:first.getDay(), weeks:Math.ceil((first.getDay()+365)/7) };
  }
  if (typeof module !== 'undefined') { module.exports = { activityDays }; return; }
  function node(tag, text, className) { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(className)n.className=className; return n; }
  globalThis.renderActivityGrid = (container, activity, thread) => {
    const end=dayKey(new Date()), signature=JSON.stringify([thread,end,activity]); if(container.dataset.signature===signature)return;
    const focused=container.contains(document.activeElement), selected=container.dataset.thread===thread?container.dataset.selected:null;
    container.dataset.signature=signature; container.dataset.thread=thread??''; container.replaceChildren();
    const data=activityDays(activity?.days), title=node('p', `近一年 · ${data.active} 个有记录的活跃日 · ${data.total.toLocaleString('zh-CN')} Token`, 'activity-heading');container.append(title);
    const months=node('div',undefined,'activity-months');months.style.gridTemplateColumns=`repeat(${data.weeks},minmax(0,1fr))`;
    for(let i=0;i<data.days.length;i++)if(i===0||data.days[i].monthStart){const week=Math.floor((data.leading+i)/7);if(week<=data.weeks-3){const m=node('span',`${data.days[i].month}月`);m.style.gridColumn=`${week+1}/span 3`;months.append(m);}}
    const board=node('div',undefined,'activity-board'), labels=node('div',undefined,'activity-weekdays'); for(const [label,row] of [['一',2],['三',4],['五',6]]){const n=node('span',label);n.style.gridRow=String(row);labels.append(n);}
    const grid=node('div',undefined,'activity-days');grid.style.gridTemplateColumns=`repeat(${data.weeks},minmax(0,1fr))`;grid.setAttribute('role','group');grid.setAttribute('aria-label','当前聊天近一年每日 Token 用量');
    for(let i=0;i<data.leading;i++)grid.append(node('span',undefined,'activity-blank'));
    const readout=node('p',undefined,'activity-readout');readout.setAttribute('role','status');readout.setAttribute('aria-live','polite'); const cells=[];
    const description=d=>`${d.date} · ${d.recorded?`${d.tokens.toLocaleString('zh-CN')} Token`:'无本地记录'}`;
    function select(index,focus=false){for(let i=0;i<cells.length;i++){cells[i].tabIndex=i===index?0:-1;cells[i].setAttribute('aria-pressed',String(i===index));}container.dataset.selected=data.days[index].date;readout.textContent=description(data.days[index]);if(focus)cells[index].focus({preventScroll:true});}
    data.days.forEach((d,index)=>{const b=node('button',undefined,'activity-cell');b.type='button';b.dataset.level=String(d.level);b.title=description(d);b.setAttribute('aria-label',description(d));b.addEventListener('click',()=>select(index));b.addEventListener('focus',()=>select(index));b.addEventListener('mouseenter',()=>{readout.textContent=description(d)});b.addEventListener('mouseleave',()=>{readout.textContent=description(data.days.find(d=>d.date===container.dataset.selected)??data.days[364])});b.addEventListener('keydown',e=>{const shifts={ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1};let next=e.key==='Home'?0:e.key==='End'?364:shifts[e.key]!==undefined?Math.max(0,Math.min(364,index+shifts[e.key])):null;if(next!==null){e.preventDefault();select(next,true);}});cells.push(b);grid.append(b);});
    container.append(months);board.append(labels,grid);container.append(board,readout);
    const footer=node('div',undefined,'activity-legend');footer.append(node('span',activity?.partial?'日志范围不完整':'颜色按本聊天的每日用量分级'),node('span','少'));for(let level=0;level<=4;level++){const swatch=node('i',undefined,'activity-cell');swatch.dataset.level=String(level);footer.append(swatch);}footer.append(node('span','多'));container.append(footer);
    select(Math.max(0,data.days.findIndex(d=>d.date===(selected??end))),focused);
  };
})();
