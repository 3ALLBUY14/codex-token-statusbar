'use strict';
const validRect = r => r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k]) && Math.abs(r[k]) < 100000) && r.width >= 200 && r.height >= 20;
function composerPosition(host, composer, size, barHeight) {
  if (!validRect(host) || !validRect(composer) || composer.x < host.x || composer.y < host.y || composer.x + composer.width > host.x + host.width + 2 || composer.y + composer.height > host.y + host.height + 2) return null;
  const gap = 4, width = Math.min(size.width, composer.width), bar = Math.max(20, barHeight);
  const below = composer.y + composer.height + gap;
  const edge = below + bar <= host.y + host.height - gap ? 'below' : 'above';
  const bottom = edge === 'below' ? below + bar : composer.y - gap;
  const height = Math.min(size.height, bottom - host.y - gap);
  if (height < bar) return null;
  return { x: Math.round(composer.x + (composer.width - width) / 2), y: Math.round(bottom - height), width: Math.ceil(width), height: Math.floor(height), edge };
}
module.exports = { validRect, composerPosition };
