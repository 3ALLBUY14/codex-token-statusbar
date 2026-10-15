'use strict';
const validRect = r => r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k]) && Math.abs(r[k]) < 100000) && r.width >= 200 && r.height >= 20;
function composerPosition(host, composer, size, barHeight, alignment = 'center') {
  if (!validRect(host) || !validRect(composer) || composer.x < host.x || composer.y < host.y || composer.x + composer.width > host.x + host.width + 2 || composer.y + composer.height > host.y + host.height + 2) return null;
  const gap = 4, width = Math.min(size.width, composer.width), bar = Math.max(20, barHeight);
  const below = composer.y + composer.height + gap;
  const edge = below + bar <= host.y + host.height - gap ? 'below' : 'above';
  const bottom = edge === 'below' ? below + bar : composer.y - gap;
  const height = Math.min(size.height, bottom - host.y - gap);
  if (height < bar) return null;
  const offset = alignment === 'left' ? 0 : alignment === 'right' ? composer.width - width : (composer.width - width) / 2;
  return { x: Math.round(composer.x + offset), y: Math.round(bottom - height), width: Math.ceil(width), height: Math.floor(height), edge };
}
function titlebarPosition(host, area, size, barHeight, alignment = 'center') {
  if (!validRect(host) || !validRect(area) || area.x < host.x || area.y < host.y || area.x + area.width > host.x + host.width + 2 || area.y + area.height > host.y + host.height || barHeight > area.height - 2) return null;
  const width = Math.min(size.width, area.width);
  const offset = alignment === 'left' ? 0 : alignment === 'right' ? area.width - width : (area.width - width) / 2;
  const y = Math.round(area.y + (area.height - barHeight) / 2);
  return { x: Math.round(area.x + offset), y, width: Math.ceil(width), height: Math.floor(Math.min(size.height, host.y + host.height - y)), edge: 'titlebar' };
}
module.exports = { validRect, composerPosition, titlebarPosition };
