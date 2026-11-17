#!/usr/bin/env node
/**
 * 快传 · 零依赖的文件直传服务
 *
 * 作用：
 *   1. 托管前端页面
 *   2. 提供 WebSocket 信令（只交换 SDP / ICE，不碰文件内容）
 *
 * 文件本身通过 WebRTC DataChannel 在两台电脑之间直连传输，
 * 服务端既不入库也不中转，关掉服务端时已建立的连接仍可继续传。
 *
 * 用法： node server.js           （默认 8787）
 *        PORT=9000 node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/* ------------------------------------------------------------------ */
/* HTTP 静态服务                                                       */
/* ------------------------------------------------------------------ */

function lanAddresses() {
  const list = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) list.push(net.address);
    }
  }
  return list;
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
    return;
  }
  if (pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ port: PORT, lan: lanAddresses() }));
    return;
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  // 阻止目录穿越
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=600',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* 极简 WebSocket 服务端（RFC 6455 子集）                               */
/* ------------------------------------------------------------------ */

class WSConn {
  constructor(socket, id) {
    this.id = id;
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.closed = false;
    this.handlers = { message: () => {}, close: () => {} };
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
  }

  on(event, fn) {
    this.handlers[event] = fn;
    return this;
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    try { this.handlers.close(); } catch (_) {}
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const frame = this._parse();
      if (!frame) break;
      this._dispatch(frame);
      if (this.closed) break;
    }
  }

  _parse() {
    const b = this.buf;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const high = b.readUInt32BE(2);
      const low = b.readUInt32BE(6);
      len = high * 4294967296 + low;
      offset = 10;
    }

    // 信令消息不该这么大，超限直接断开
    if (len > 32 * 1024 * 1024) {
      this.socket.destroy();
      this._onClose();
      return null;
    }

    const maskLen = masked ? 4 : 0;
    if (b.length < offset + maskLen + len) return null;

    let payload = b.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = b.subarray(offset, offset + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }

    this.buf = b.subarray(offset + maskLen + len);
    return { fin, opcode, payload };
  }

  _dispatch({ fin, opcode, payload }) {
    if (opcode === 0x8) { // close
      this.close();
      return;
    }
    if (opcode === 0x9) { // ping
      this._send(0xa, payload);
      return;
    }
    if (opcode === 0xa) return; // pong

    if (opcode === 0x0) { // continuation
      this.frags.push(payload);
    } else {
      this.frags = [payload];
    }
    if (!fin) return;

    const full = this.frags.length === 1 ? this.frags[0] : Buffer.concat(this.frags);
    this.frags = [];
    try { this.handlers.message(full.toString('utf8')); } catch (_) {}
  }

  _send(opcode, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 4294967296), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    header[0] = 0x80 | opcode;
    try { this.socket.write(Buffer.concat([header, payload])); } catch (_) {}
  }

  sendJSON(obj) {
    this._send(0x1, Buffer.from(JSON.stringify(obj)));
  }

  close() {
    if (this.closed) return;
    this._send(0x8, Buffer.alloc(0));
    this.closed = true;
    try { this.socket.end(); } catch (_) {}
    try { this.handlers.close(); } catch (_) {}
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 轮询信令：WebSocket 被代理/网关拦截时的降级通道                 */
/* 与 WSConn 保持同一套接口（sendJSON / room / closed），房间逻辑完全复用 */
/* ------------------------------------------------------------------ */

const pollSessions = new Map(); // sid -> PollConn
let pollSeq = 0;

class PollConn {
  constructor() {
    this.sid = crypto.randomBytes(12).toString('hex') + (++pollSeq);
    this.room = null;
    this.closed = false;
    this.queue = [];
    this.waiters = [];
    this.lastSeen = Date.now();
  }

  sendJSON(obj) {
    if (this.closed) return;
    this.queue.push(obj);
    this.flush();
  }

  flush() {
    while (this.waiters.length && this.queue.length) {
      this.waiters.shift()(this.queue.shift());
    }
  }

  take(timeoutMs) {
    this.lastSeen = Date.now();
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve) => {
      let done = false;
      const finish = (msg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = this.waiters.indexOf(fn);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(msg);
      };
      const fn = (msg) => finish(msg);
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.waiters.push(fn);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.waiters.splice(0).forEach((fn) => fn(null));
  }
}

function sendJSONBody(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleSignalApi(req, res, pathname, url) {
  if (pathname === '/api/sig/open') {
    const conn = new PollConn();
    pollSessions.set(conn.sid, conn);
    sendJSONBody(res, 200, { sid: conn.sid });
    return;
  }

  if (pathname === '/api/sig/send') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (_) {
      sendJSONBody(res, 400, { error: 'bad request' });
      return;
    }
    const conn = pollSessions.get(String(payload.sid || ''));
    if (!conn) {
      sendJSONBody(res, 410, { error: 'session expired' });
      return;
    }
    conn.lastSeen = Date.now();
    handleMessage(conn, JSON.stringify(payload.msg || {}));
    sendJSONBody(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/sig/poll') {
    const sid = String(url.searchParams.get('sid') || '');
    const conn = pollSessions.get(sid);
    if (!conn) {
      sendJSONBody(res, 410, { error: 'session expired' });
      return;
    }
    const wait = Math.min(Number(url.searchParams.get('t')) || 10000, 30000);
    const msg = await conn.take(wait);
    if (!msg) {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    sendJSONBody(res, 200, { msgs: [msg] });
    return;
  }

  sendJSONBody(res, 404, { error: 'not found' });
}

/* ------------------------------------------------------------------ */
/* 房间与信令                                                          */
/* ------------------------------------------------------------------ */

const rooms = new Map(); // code -> { host, guest, createdAt }
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 0/O/1/I
let connSeq = 0;

function newRoomCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-6);
}

function peerOf(conn) {
  const room = rooms.get(conn.room);
  if (!room) return null;
  return room.host === conn ? room.guest : room.host;
}

const MAX_MEMBERS = 8;

// 2 人房走 P2P（host/guest），第 3 人起挂在 others 上，只走服务器分发
function otherConns(room) {
  return (room.others || []).map((m) => m.conn).filter(Boolean);
}

function roomConns(room) {
  return [room.host, room.guest, ...otherConns(room)].filter(Boolean);
}

function memberCount(room) {
  return roomConns(room).length;
}

function pushMembers(code) {
  const room = rooms.get(code);
  if (!room) return;
  const count = memberCount(room);
  for (const c of roomConns(room)) {
    if (!c.closed) c.sendJSON({ t: 'members', count });
  }
}

function broadcast(code, msg, except) {
  const room = rooms.get(code);
  if (!room) return;
  for (const c of roomConns(room)) {
    if (c !== except && !c.closed) c.sendJSON(msg);
  }
}
const RESUME_GRACE = 90 * 1000; // 掉线后房间保留这么久，带 token 回来还能续上

function newToken() {
  return crypto.randomBytes(8).toString('hex');
}

function cleanupRoomLater(code) {
  setTimeout(() => {
    const room = rooms.get(code);
    if (room && !room.host && !room.guest) rooms.delete(code);
  }, RESUME_GRACE).unref();
}

function detach(conn, graceful) {
  const code = conn.room;
  if (!code) return;
  conn.room = null;
  const room = rooms.get(code);
  if (!room) return;

  const now = Date.now();
  if (room.host === conn) { room.host = null; room.hostOfflineAt = now; }
  if (room.guest === conn) { room.guest = null; room.guestOfflineAt = now; }
  if (room.others) {
    const idx = room.others.findIndex((m) => m.conn === conn);
    if (idx >= 0) {
      if (graceful) room.others.splice(idx, 1);
      else { room.others[idx].conn = null; room.others[idx].offAt = now; }
    }
  }

  if (graceful) {
    // 主动离开：房间立刻作废，token 一起清掉
    room.hostToken = null;
    room.guestToken = null;
  }

  broadcast(code, { t: graceful ? 'peer-left' : 'peer-offline' });
  const alive = roomConns(room).length;
  if (alive > 1) pushMembers(code);
  if (alive === 0) {
    if (graceful) rooms.delete(code);
    else cleanupRoomLater(code);
  }
}

function handleMessage(conn, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (!msg || typeof msg.t !== 'string') return;

  switch (msg.t) {
    case 'create': {
      detach(conn, true);
      let code = newRoomCode();
      const preferred = String(msg.code || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
      if (preferred.length === 6 && !rooms.has(preferred)) code = preferred;
      const token = newToken();
      rooms.set(code, {
        host: conn, guest: null, others: [],
        hostToken: token, guestToken: null,
        hostOfflineAt: 0, guestOfflineAt: 0,
        createdAt: Date.now(),
      });
      conn.room = code;
      conn.token = token;
      conn.sendJSON({ t: 'created', code, token });
      console.log(`[房间] 创建 ${code}  (当前 ${rooms.size} 个房间)`);
      break;
    }

    case 'join': {
      const code = String(msg.code || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
      const room = rooms.get(code);
      if (!room) {
        conn.sendJSON({ t: 'error', msg: '房间不存在，请确认房间码是否正确' });
        return;
      }
      if (!room.host) {
        // 房主暂时离线，接手成为新房主更符合直觉
        detach(conn, true);
        const token = newToken();
        room.host = conn;
        room.guest = null;
        room.hostToken = token;
        room.hostOfflineAt = 0;
        conn.room = code;
        conn.token = token;
        conn.sendJSON({ t: 'created', code, token, adopted: true });
        return;
      }
      if (room.guest) {
        if (memberCount(room) >= MAX_MEMBERS) {
          conn.sendJSON({ t: 'error', msg: '房间已满（最多 ' + MAX_MEMBERS + ' 台设备）' });
          return;
        }
        detach(conn, true);
        if (!room.others) room.others = [];
        const groupToken = newToken();
        room.others.push({ conn, token: groupToken, offAt: 0 });
        conn.room = code;
        conn.token = groupToken;
        conn.sendJSON({ t: 'joined', code, token: groupToken, group: true });
        broadcast(code, { t: 'peer-joined' }, conn);
        pushMembers(code);
        console.log(`[房间] ${code} 第 ${memberCount(room)} 台设备加入`);
        return;
      }
      detach(conn, true);
      const guestToken = newToken();
      room.guest = conn;
      room.guestToken = guestToken;
      room.guestOfflineAt = 0;
      conn.room = code;
      conn.token = guestToken;
      conn.sendJSON({ t: 'joined', code, token: guestToken });
      broadcast(code, { t: 'peer-joined' }, conn);
      pushMembers(code);
      room.host.sendJSON({ t: 'start', initiator: true });
      conn.sendJSON({ t: 'start', initiator: false });
      console.log(`[房间] ${code} 两台设备已配对`);
      break;
    }

    case 'resume': {
      detach(conn, true);
      const code = String(msg.code || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
      const token = String(msg.token || '');
      const room = rooms.get(code);
      if (!room || !token) {
        conn.sendJSON({ t: 'resume-failed', code, msg: '房间已失效' });
        return;
      }
      let role = null;
      const otherIdx = (room.others || []).findIndex((m) => m.token === token);
      if (room.hostToken === token) { room.host = conn; room.hostOfflineAt = 0; role = 'host'; }
      else if (room.guestToken === token) { room.guest = conn; room.guestOfflineAt = 0; role = 'guest'; }
      else if (otherIdx >= 0) { room.others[otherIdx].conn = conn; room.others[otherIdx].offAt = 0; role = 'guest'; }
      if (!role) {
        conn.sendJSON({ t: 'resume-failed', code, msg: '房间已失效' });
        return;
      }
      conn.room = code;
      conn.token = token;
      conn.sendJSON({ t: 'resumed', code, role });
      pushMembers(code);
      console.log(`[房间] ${code} ${role} 重新接入`);

      const other = role === 'host' ? room.guest : room.host;
      if (other && memberCount(room) === 2) {
        other.sendJSON({ t: 'peer-online' });
        const initiator = role === 'host';
        conn.sendJSON({ t: 'start', initiator });
        other.sendJSON({ t: 'start', initiator: !initiator });
      }
      break;
    }

    case 'signal': {
      // 2 人房只有 1 个接收者，多人房里就是把中转通知广播给所有其他人
      broadcast(conn.room, { t: 'signal', data: msg.data }, conn);
      break;
    }

    case 'ping':
      conn.sendJSON({ t: 'pong' });
      break;

    case 'leave':
      detach(conn, true);
      conn.sendJSON({ t: 'left' });
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* 中转通道：P2P 打不通时的兜底，文件临时落盘，下载完/超时即删            */
/* ------------------------------------------------------------------ */

const RELAY_DIR = path.join(os.tmpdir(), 'kuaichuan-relay');
const RELAY_MAX = 4 * 1024 * 1024 * 1024; // 单文件 4GB
const RELAY_TTL = 30 * 60 * 1000;

const relays = new Map(); // id -> { file, name, size, createdAt }

function ensureRelayDir() {
  try { fs.mkdirSync(RELAY_DIR, { recursive: true }); } catch (_) {}
}

function dropRelay(id) {
  const rec = relays.get(id);
  if (!rec) return;
  relays.delete(id);
  fs.unlink(rec.file, () => {});
}

function safeFileName(raw, fallback) {
  let name = fallback;
  try { name = decodeURIComponent(String(raw || '')); } catch (_) { name = String(raw || fallback); }
  name = name.replace(/[\r\n\\/"]/g, '_').trim().slice(0, 180);
  return name || fallback;
}

async function handleRelayApi(req, res, pathname, url) {
  if (pathname === '/relay/upload' && req.method === 'POST') {
    ensureRelayDir();
    const id = crypto.randomBytes(16).toString('hex');
    const name = safeFileName(req.headers['x-file-name'], 'file.bin');
    const dest = path.join(RELAY_DIR, id);

    const out = fs.createWriteStream(dest);
    let size = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > RELAY_MAX && !aborted) {
        aborted = true;
        out.destroy();
        req.destroy();
        fs.unlink(dest, () => {});
        try { sendJSONBody(res, 413, { error: '文件超过 4GB 上限' }); } catch (_) {}
      }
    });
    req.on('aborted', () => {
      aborted = true;
      out.destroy();
      fs.unlink(dest, () => {});
    });
    out.on('error', () => {
      if (aborted) return;
      aborted = true;
      try { sendJSONBody(res, 500, { error: '写入失败' }); } catch (_) {}
    });
    out.on('finish', () => {
      if (aborted) return;
      relays.set(id, { file: dest, name, size, createdAt: Date.now() });
      sendJSONBody(res, 200, { id, size, name });
    });
    req.pipe(out);
    return;
  }

  if (pathname === '/relay/file' && req.method === 'GET') {
    const id = String(url.searchParams.get('id') || '');
    const rec = relays.get(id);
    if (!rec) {
      sendJSONBody(res, 404, { error: '文件已过期或不存在' });
      return;
    }
    let stat;
    try { stat = fs.statSync(rec.file); } catch (_) {
      relays.delete(id);
      sendJSONBody(res, 404, { error: '文件已不存在' });
      return;
    }
    const encoded = encodeURIComponent(rec.name);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encoded,
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(rec.file);
    stream.pipe(res);
    stream.on('close', () => {
      setTimeout(() => dropRelay(id), 60 * 1000).unref();
    });
    return;
  }

  if (pathname === '/relay/cancel' && req.method === 'POST') {
    const id = String(url.searchParams.get('id') || '');
    dropRelay(id);
    sendJSONBody(res, 200, { ok: true });
    return;
  }

  sendJSONBody(res, 404, { error: 'not found' });
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/relay/')) {
    handleRelayApi(req, res, pathname, url).catch(() => {
      try { sendJSONBody(res, 500, { error: 'internal' }); } catch (_) {}
    });
    return;
  }
  if (pathname.startsWith('/api/sig/')) {
    handleSignalApi(req, res, pathname, url).catch(() => {
      try { sendJSONBody(res, 500, { error: 'internal' }); } catch (_) {}
    });
    return;
  }
  serveStatic(req, res);
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  const conn = new WSConn(socket, ++connSeq);
  conn.room = null;
  conn.on('message', (raw) => handleMessage(conn, raw));
  conn.on('close', () => detach(conn));
});

// 清理超时房间（12 小时没人用就丢掉）
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    // 清掉掉线超过宽限期的群成员
    if (room.others) {
      room.others = room.others.filter((m) => m.conn || now - (m.offAt || 0) <= RESUME_GRACE);
    }
    if (roomConns(room).length > 0) {
      if (now - room.createdAt > 12 * 3600 * 1000 && !room.guest) rooms.delete(code);
      continue;
    }
    const lastGone = Math.max(room.hostOfflineAt || 0, room.guestOfflineAt || 0);
    if (now - lastGone > RESUME_GRACE) rooms.delete(code);
  }
}, 30 * 60 * 1000).unref();

// 清理过期中转文件
setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of relays) {
    if (now - rec.createdAt > RELAY_TTL) dropRelay(id);
  }
}, 5 * 60 * 1000).unref();

// 清理掉线超过 2 分钟的轮询会话
setInterval(() => {
  const now = Date.now();
  for (const [sid, conn] of pollSessions) {
    if (conn.closed || now - conn.lastSeen > 120 * 1000) {
      detach(conn);
      conn.close();
      pollSessions.delete(sid);
    }
  }
}, 30 * 1000).unref();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。换一个端口：PORT=8788 node server.js\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const lan = lanAddresses();
  console.log('');
  console.log('  快传 已启动');
  console.log('  ────────────────────────────────');
  console.log(`  本机访问   http://localhost:${PORT}`);
  lan.forEach((ip) => console.log(`  局域网     http://${ip}:${PORT}   ← 另一台电脑用这个`));
  console.log('  ────────────────────────────────');
  console.log('  按 Ctrl+C 停止服务\n');
});
