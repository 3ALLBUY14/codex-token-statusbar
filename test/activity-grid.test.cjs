'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {activityDays}=require('../src/ui/activity-grid.js');
test('heatmap has 365 local calendar dates, leap days and 53 aligned week columns',()=>{
  const r=activityDays([{date:'2024-02-29',tokens:100},{date:'2024-03-01',tokens:400},{date:'2023-01-01',tokens:9999}], '2024-03-01');
  assert.equal(r.days.length,365);assert.equal(new Set(r.days.map(d=>d.date)).size,365);assert.equal(r.days.at(-1).date,'2024-03-01');
  assert.equal(r.days.find(d=>d.date==='2024-02-29').level,1);assert.equal(r.days.at(-1).level,4);assert.equal(r.total,500);assert.equal(r.active,2);assert.equal(r.weeks,53);
});
test('empty and malformed values do not invent activity, and year boundary dates stay ordered',()=>{
  const r=activityDays([{date:'2026-12-31',tokens:-1},{date:'2027-01-01',tokens:NaN},{date:'2027-01-02',tokens:1}], '2027-01-01');
  assert.equal(r.total,0);assert.equal(r.days.at(-1).date,'2027-01-01');assert.ok(r.days.every(d=>d.level===0));
  assert.throws(()=>activityDays([], '2026-02-30'));assert.throws(()=>activityDays([], 'invalid'));
});
