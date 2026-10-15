'use strict';
// Some desktop shells remove WS_EX_TOPMOST after creation. Reassert without focus.
class OverlayLayer {
  constructor(now = Date.now) { this.now = now; this.last = -Infinity; this.enabled = null; }
  maintain(win, { enabled = true, suspended = false, force = false } = {}) {
    if (suspended || !win || win.isDestroyed() || !win.isVisible()) return false;
    if (!enabled) {
      if (this.enabled !== false) win.setAlwaysOnTop(true, 'floating');
      this.enabled = false; return false;
    }
    const now = this.now();
    if (!force && now - this.last < 1000) return false;
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.moveTop();
    this.enabled = true;
    this.last = now;
    return true;
  }
}
module.exports = { OverlayLayer };
