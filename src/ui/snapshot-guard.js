'use strict';
// The main process numbers snapshots across chat switches and reconnects.
class SnapshotGuard {
  constructor() { this.sequence = -1; this.epoch = -1; this.thread = null; }
  accept(state) {
    if (!state?.selection || state.session && state.session.threadId !== state.selection.threadId) return false;
    const d = state.delivery;
    if (!d) return true; // Standalone synthetic previews have no transport sequence.
    if (!Number.isSafeInteger(d.sequence) || !Number.isSafeInteger(d.epoch) || d.sequence < 0 || d.epoch < 0 || d.sequence <= this.sequence || d.epoch < this.epoch) return false;
    if (d.epoch === this.epoch && state.selection.threadId !== this.thread) return false;
    this.sequence = d.sequence; this.epoch = d.epoch; this.thread = state.selection.threadId; return true;
  }
}
if (typeof module !== 'undefined') module.exports = { SnapshotGuard };
else globalThis.SnapshotGuard = SnapshotGuard;
