'use strict';

const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const MAX_FRAME = 256 * 1024 * 1024;
const MAX_JSON_FRAME = 4 * 1024 * 1024;

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length);
  return Buffer.concat([prefix, payload]);
}

class FrameDecoder {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.prefix = Buffer.alloc(4);
    this.prefixOffset = 0;
    this.remaining = 0;
    this.parts = [];
    this.skip = false;
  }
  push(buffer) {
    let offset = 0;
    while (offset < buffer.length) {
      if (this.remaining === 0) {
        const count = Math.min(4 - this.prefixOffset, buffer.length - offset);
        buffer.copy(this.prefix, this.prefixOffset, offset, offset + count);
        this.prefixOffset += count;
        offset += count;
        if (this.prefixOffset < 4) continue;
        this.prefixOffset = 0;
        this.remaining = this.prefix.readUInt32LE();
        if (this.remaining === 0 || this.remaining > MAX_FRAME) throw new Error('invalid-ipc-frame');
        this.skip = this.remaining > MAX_JSON_FRAME;
        this.parts = [];
      }
      const count = Math.min(this.remaining, buffer.length - offset);
      if (!this.skip) this.parts.push(buffer.subarray(offset, offset + count));
      this.remaining -= count;
      offset += count;
      if (this.remaining === 0 && !this.skip) {
        let value;
        try { value = JSON.parse(Buffer.concat(this.parts).toString('utf8')); } catch { this.parts = []; continue; }
        this.parts = [];
        this.onFrame(value);
      }
    }
  }
}

class CodexIpc extends EventEmitter {
  constructor(endpoint = '\\\\.\\pipe\\codex-ipc', { recoveryDelay = 2000, recoveryCooldown = 10000 } = {}) {
    super();
    this.endpoint = endpoint;
    this.routes = new Map();
    this.connected = false;
    this.selectedId = null;
    this.timer = null;
    this.socket = null;
    this.stopped = false;
    this.retryDelay = 500;
    this.clientId = null;
    this.initializeId = null;
    this.initializeTimer = null;
    this.recoveryTimer = null;
    this.recoveryDelay = recoveryDelay;
    this.recoveryCooldown = recoveryCooldown;
    this.lastRecovery = 0;
  }
  status() { return { connected: this.connected, threadId: this.selectedId, routeCount: this.routes.size, ambiguous: new Set(this.routes.values()).size > 1 }; }
  send(value) {
    if (this.socket?.writable && !this.socket.destroyed) this.socket.write(frame(value));
  }
  recoverIfUnbound() {
    clearTimeout(this.recoveryTimer);
    if (!this.connected || this.routes.size || this.stopped) return;
    const delay = Math.max(this.recoveryDelay, this.lastRecovery + this.recoveryCooldown - Date.now());
    this.recoveryTimer = setTimeout(() => {
      if (!this.connected || this.routes.size || this.stopped) return;
      // There is no request for all current subscriptions. A new client registration
      // makes Desktop resend its followed chats, including chats with no new tokens.
      this.lastRecovery = Date.now();
      this.socket?.destroy();
    }, delay);
  }
  refreshBinding() { if (!this.stopped) this.socket?.destroy(); }
  processFrame(value) {
    if (value?.type === 'client-discovery-request' && typeof value.requestId === 'string') {
      this.send({ type: 'client-discovery-response', requestId: value.requestId, response: { canHandle: false } });
      return;
    }
    if (value?.type === 'request' && typeof value.requestId === 'string') {
      this.send({ type: 'response', requestId: value.requestId, resultType: 'error', error: 'no-handler-for-request' });
      return;
    }
    if (value?.type === 'response' && this.initializeId && value.requestId === this.initializeId) {
      if (value.resultType !== 'success' || value.method !== 'initialize' || typeof value.result?.clientId !== 'string') {
        this.socket?.destroy();
        return;
      }
      clearTimeout(this.initializeTimer);
      this.initializeId = null;
      this.clientId = value.result.clientId;
      this.connected = true;
      this.retryDelay = 500;
      this.emit('status', this.status());
      this.recoverIfUnbound();
      return;
    }
    if (value?.type !== 'broadcast' || !value.params || typeof value.params !== 'object') return;
    if (value.targetClientIds != null && (!Array.isArray(value.targetClientIds) || !value.targetClientIds.includes(this.clientId))) return;
    const p = value.params;
    if (value.method === 'thread-stream-following-changed') {
      if (!UUID.test(p.conversationId ?? '') || typeof p.hostId !== 'string' || typeof value.sourceClientId !== 'string' || typeof p.following !== 'boolean') return;
      const key = `${value.sourceClientId}\u001f${p.hostId}\u001f${p.conversationId}`;
      if (p.following) this.routes.set(key, p.conversationId);
      else if (this.routes.get(key) === p.conversationId) this.routes.delete(key);
    } else if (value.method === 'client-status-changed' && p.status === 'disconnected' && typeof p.clientId === 'string') {
      for (const key of this.routes.keys()) if (key.startsWith(`${p.clientId}\u001f`)) this.routes.delete(key);
    } else return;
    // Multiple desktop windows cannot be mapped to HWNDs through this protocol.
    // Do not claim that the last event necessarily belongs to the foreground one.
    const ids = [...new Set(this.routes.values())];
    this.selectedId = ids.length === 1 ? ids[0] : null;
    this.emit('status', this.status());
    this.recoverIfUnbound();
  }
  start() {
    if (this.stopped || this.socket && !this.socket.destroyed) return;
    const socket = this.socket = net.createConnection(this.endpoint);
    const decoder = new FrameDecoder(value => this.processFrame(value));
    const connectTimeout = setTimeout(() => socket.destroy(), 3000);
    socket.on('connect', () => {
      this.initializeId = randomUUID();
      this.initializeTimer = connectTimeout;
      // Initialization only; no conversation writes, prompts, or inference.
      this.send({ type: 'request', requestId: this.initializeId, sourceClientId: 'initializing-client', version: 0, method: 'initialize', params: { clientType: 'codex-token-statusbar' } });
    });
    socket.on('data', data => { try { decoder.push(data); } catch { socket.destroy(); } });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(connectTimeout);
      clearTimeout(this.recoveryTimer);
      this.clientId = null;
      this.initializeId = null;
      this.connected = false;
      this.routes.clear();
      this.selectedId = null;
      this.emit('status', this.status());
      if (!this.stopped) {
        this.timer = setTimeout(() => this.start(), this.retryDelay);
        this.retryDelay = Math.min(10000, this.retryDelay * 2);
      }
    });
  }
  stop() { this.stopped = true; clearTimeout(this.timer); clearTimeout(this.recoveryTimer); clearTimeout(this.initializeTimer); this.socket?.destroy(); }
}

module.exports = { CodexIpc, FrameDecoder, frame, UUID };
