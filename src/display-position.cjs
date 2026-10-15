'use strict';
const PLACEMENTS = ['top-right', 'bottom-right', 'bottom-center'];
function anchorPosition(host, size, placement) {
  return { x: placement === 'bottom-center' ? host.x + (host.width - size.width) / 2 : host.x + host.width - size.width - 18, y: placement === 'top-right' ? host.y + 52 : host.y + host.height - size.height - 22 };
}
function cleanProfiles(profiles) {
  if (!Array.isArray(profiles)) return [];
  const unique = new Map();
  for (const value of profiles.slice(-16)) {
    if (!value || ![value.hostId, value.targetId].every(id => typeof id === 'string' && /^-?\d{1,16}$/.test(id)) || !PLACEMENTS.includes(value.placement) || ![value.offsetX, value.offsetY].every(n => Number.isFinite(n) && Math.abs(n) <= 20000)) continue;
    unique.set(value.hostId, { hostId: value.hostId, targetId: value.targetId, placement: value.placement, offsetX: Math.round(value.offsetX), offsetY: Math.round(value.offsetY) });
  }
  return [...unique.values()];
}
function displayPosition(value, host, displays) {
  const profile = value.rememberDisplayPositions ? value.displayPositions?.find(item => item.hostId === String(host.id)) : null;
  const target = profile && displays.find(item => String(item.id) === profile.targetId);
  if (profile && !target) return { display: host, placement: profile.placement, offsetX: 0, offsetY: 0, remembered: false };
  return { display: target || host, placement: profile?.placement ?? value.placement, offsetX: profile?.offsetX ?? value.offsetX, offsetY: profile?.offsetY ?? value.offsetY, remembered: Boolean(profile) };
}
function positionPatch(value, host, target, patch) {
  if (!value.rememberDisplayPositions) return patch;
  const previous = displayPosition(value, host, [host, target]);
  return { displayPositions: cleanProfiles([...(value.displayPositions || []).filter(item => item.hostId !== String(host.id)), { hostId: String(host.id), targetId: String(target.id), placement: patch.placement ?? previous.placement, offsetX: patch.offsetX ?? previous.offsetX, offsetY: patch.offsetY ?? previous.offsetY }]) };
}
function clampBounds(bounds, work) {
  const width = Math.min(Math.ceil(bounds.width), work.width), height = Math.min(Math.ceil(bounds.height), work.height);
  return { x: Math.round(Math.max(work.x, Math.min(bounds.x, work.x + work.width - width))), y: Math.round(Math.max(work.y, Math.min(bounds.y, work.y + work.height - height))), width, height };
}
module.exports = { anchorPosition, cleanProfiles, displayPosition, positionPatch, clampBounds };
