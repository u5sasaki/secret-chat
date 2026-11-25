'use strict';
// URLを知っている人だけが入れるグループチャット。
// 合言葉URL: https://<ホスト>/r/<ROOM_TOKEN>  それ以外のパスは全て404。
// メッセージと画像は24時間で自動削除。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MSG_FILE = path.join(DATA_DIR, 'messages.json');
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_TEXT = 2000;
const MAX_NAME = 20;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- ルームトークン（URLの秘密部分） ----
function loadToken() {
  if (process.env.ROOM_TOKEN) return process.env.ROOM_TOKEN;
  const f = path.join(DATA_DIR, 'token.txt');
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch (_) {
    const t = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(f, t);
    return t;
  }
}
const TOKEN = loadToken();
if (!/^[A-Za-z0-9_-]{16,}$/.test(TOKEN)) {
  console.error('ROOM_TOKEN は英数字・-・_ の16文字以上にしてください。');
  process.exit(1);
}
const BASE = '/r/' + TOKEN;

// ---- メッセージ保存 ----
let messages = [];
try {
  messages = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8'));
} catch (_) {}
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(MSG_FILE, JSON.stringify(messages), () => {});
  }, 500);
}

function cleanup() {
  const limit = Date.now() - TTL_MS;
  const before = messages.length;
  messages = messages.filter((m) => m.ts >= limit);
  const keep = new Set(messages.filter((m) => m.image).map((m) => m.image));
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const p = path.join(UPLOAD_DIR, f);
    let old = false;
    try {
      old = fs.statSync(p).mtimeMs < limit;
    } catch (_) {}
    if (old || !keep.has(f)) {
      // 参照されていない・24時間超の画像は削除（アップロード直後の画像は猶予60秒）
      let young = false;
      try {
        young = Date.now() - fs.statSync(p).mtimeMs < 60 * 1000;
      } catch (_) {}
      if (old || !young) fs.unlink(p, () => {});
    }
  }
  if (messages.length !== before) {
    scheduleSave();
    broadcast({ type: 'prune', before: limit });
  }
}
setInterval(cleanup, 10 * 60 * 1000);

// ---- HTTP ----
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

function baseHeaders(extra) {
  return Object.assign(
    {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
    extra
  );
}
function notFound(res) {
  res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
  res.end('Not Found');
}

function sniffType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/robots.txt') {
    res.writeHead(200, baseHeaders({ 'Content-Type': 'text/plain' }));
    return res.end('User-agent: *\nDisallow: /\n');
  }
  if (p === '/healthz') {
    res.writeHead(200, baseHeaders({ 'Content-Type': 'text/plain' }));
    return res.end('ok');
  }

  if (req.method === 'GET' && (p === BASE || p === BASE + '/')) {
    res.writeHead(
      200,
      baseHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      })
    );
    return res.end(INDEX);
  }

  if (req.method === 'GET' && p.startsWith(BASE + '/img/')) {
    const name = p.slice((BASE + '/img/').length);
    if (!/^[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(name)) return notFound(res);
    const file = path.join(UPLOAD_DIR, name);
    fs.readFile(file, (err, data) => {
      if (err) return notFound(res);
      res.writeHead(
        200,
        baseHeaders({
          'Content-Type': MIME[name.split('.')[1]],
          'Cache-Control': 'private, max-age=3600',
        })
      );
      res.end(data);
    });
    return;
  }

  if (req.method === 'POST' && p === BASE + '/upload') {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_UPLOAD) {
        aborted = true;
        res.writeHead(413, baseHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const buf = Buffer.concat(chunks);
      const ext = sniffType(buf);
      if (!ext) {
        res.writeHead(415, baseHeaders({ 'Content-Type': 'application/json' }));
        return res.end(JSON.stringify({ error: 'unsupported' }));
      }
      const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
      fs.writeFile(path.join(UPLOAD_DIR, name), buf, (err) => {
        if (err) {
          res.writeHead(500, baseHeaders({ 'Content-Type': 'application/json' }));
          return res.end(JSON.stringify({ error: 'write_failed' }));
        }
        res.writeHead(200, baseHeaders({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ image: name }));
      });
    });
    return;
  }

  notFound(res);
});

// ---- WebSocket ----
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p !== BASE + '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}
function sendPresence() {
  broadcast({ type: 'presence', count: [...wss.clients].filter((c) => c.readyState === 1).length });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.sendTimes = [];
  ws.on('pong', () => (ws.isAlive = true));

  const limit = Date.now() - TTL_MS;
  messages = messages.filter((m) => m.ts >= limit);
  ws.send(JSON.stringify({ type: 'history', messages }));
  sendPresence();

  ws.on('message', (raw) => {
    let d;
    try {
      d = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (!d || d.type !== 'msg') return;

    const now = Date.now();
    ws.sendTimes = ws.sendTimes.filter((t) => now - t < 10000);
    if (ws.sendTimes.length >= 20) return; // 10秒に20通まで
    ws.sendTimes.push(now);

    const name = String(d.name || '').trim().slice(0, MAX_NAME);
    const text = String(d.text || '').slice(0, MAX_TEXT);
    const image = typeof d.image === 'string' && /^[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(d.image) ? d.image : null;
    if (!name || (!text.trim() && !image)) return;
    if (image && !fs.existsSync(path.join(UPLOAD_DIR, image))) return;

    const m = {
      id: crypto.randomBytes(8).toString('hex'),
      cid: String(d.cid || '').slice(0, 40),
      name,
      text,
      image,
      ts: now,
    };
    messages.push(m);
    scheduleSave();
    broadcast({ type: 'msg', message: m });
  });

  ws.on('close', sendPresence);
});

// 切れた接続の掃除
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  cleanup(); // 起動時にも期限切れを掃除（wss初期化後に実行）
  console.log('チャットを起動しました。参加用URLのパス:');
  console.log('  ' + BASE);
  console.log('  例: http://localhost:' + PORT + BASE);
});
