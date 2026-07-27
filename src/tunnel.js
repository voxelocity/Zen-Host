'use strict';

// A pure-Node client for the `bore` tunnel protocol (github.com/ekzhang/bore),
// so Zen Host can expose a local server to the internet with no router config and
// no bundled binary. Connects to the public bore.pub relay by default.
//
// Wire protocol: null-delimited JSON messages on TCP control port 7835.
//   client -> { "Hello": 0 }                request a random public port
//   server -> { "Hello": <port> }           assigned public port
//   server -> "Heartbeat"                    keep-alive (ignored)
//   server -> { "Connection": "<uuid>" }     an inbound visitor; open a data conn
//   client(data) -> { "Accept": "<uuid>" }   then raw-proxy to the local service

const net = require('net');
const { EventEmitter } = require('events');

const DEFAULT_HOST = 'bore.pub';
const CONTROL_PORT = 7835;

class Tunnel extends EventEmitter {
  constructor(localPort, opts = {}) {
    super();
    this.localPort = localPort;
    this.host = opts.host || DEFAULT_HOST;
    this.controlPort = opts.controlPort || CONTROL_PORT;
    this.control = null;
    this.dataSockets = new Set();
    this.stopped = false;
    this.remotePort = null;
    this._retry = null;
    this._handshakeTimer = null;
  }

  get address() { return this.remotePort ? `${this.host}:${this.remotePort}` : null; }

  start() {
    this.stopped = false;
    this._connectControl();
    return this;
  }

  _connectControl() {
    this.emit('status', 'connecting');
    const sock = net.connect(this.controlPort, this.host);
    this.control = sock;
    sock.setKeepAlive(true, 30000);
    let buf = Buffer.alloc(0);

    this._handshakeTimer = setTimeout(() => {
      if (!this.remotePort && !this.stopped) {
        this.emit('error', new Error('Tunnel handshake timed out (bore.pub unreachable)'));
        sock.destroy();
      }
    }, 9000);

    sock.on('connect', () => sock.write(JSON.stringify({ Hello: 0 }) + '\0'));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let idx;
      while ((idx = buf.indexOf(0)) !== -1) {
        const line = buf.slice(0, idx).toString('utf8');
        buf = buf.slice(idx + 1);
        if (line) this._handleControl(line);
      }
    });
    sock.on('error', (e) => this.emit('error', e));
    sock.on('close', () => {
      clearTimeout(this._handshakeTimer);
      if (this.stopped) return;
      this.remotePort = null;
      this.emit('status', 'reconnecting');
      this._retry = setTimeout(() => { if (!this.stopped) this._connectControl(); }, 3000);
    });
  }

  _handleControl(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg === 'Heartbeat') return;
    if (typeof msg !== 'object' || msg === null) return;
    if ('Hello' in msg) {
      clearTimeout(this._handshakeTimer);
      this.remotePort = msg.Hello;
      this.emit('ready', { host: this.host, port: this.remotePort, address: this.address });
      this.emit('status', 'online');
    } else if ('Connection' in msg) {
      this._accept(msg.Connection);
    } else if ('Challenge' in msg) {
      this.emit('error', new Error('Tunnel server requires a secret (not supported)'));
    } else if ('Error' in msg) {
      this.emit('error', new Error(String(msg.Error)));
    }
  }

  // A visitor arrived: open a fresh data connection, claim it, then raw-proxy
  // bytes between the relay and the local Minecraft server.
  _accept(uuid) {
    const data = net.connect(this.controlPort, this.host);
    const local = net.connect(this.localPort, '127.0.0.1');
    this.dataSockets.add(data);
    this.dataSockets.add(local);
    const cleanup = () => {
      data.destroy(); local.destroy();
      this.dataSockets.delete(data); this.dataSockets.delete(local);
    };
    data.on('connect', () => data.write(JSON.stringify({ Accept: uuid }) + '\0'));
    data.pipe(local);
    local.pipe(data);
    data.on('error', cleanup); local.on('error', cleanup);
    data.on('close', cleanup); local.on('close', cleanup);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this._retry);
    clearTimeout(this._handshakeTimer);
    if (this.control) this.control.destroy();
    for (const s of this.dataSockets) s.destroy();
    this.dataSockets.clear();
    this.remotePort = null;
    this.emit('status', 'off');
  }
}

module.exports = { Tunnel };
