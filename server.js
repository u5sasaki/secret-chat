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
const MAX_NAME = 30; // 「B-201 」＋名前20文字

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

// ---- オーナー/家守 専用URL（環境変数 OWNER_TOKEN で固定） ----
const OWNER_TOKEN = process.env.OWNER_TOKEN || '';
if (OWNER_TOKEN && (!/^[A-Za-z0-9_-]{16,}$/.test(OWNER_TOKEN) || OWNER_TOKEN === TOKEN)) {
  console.error('OWNER_TOKEN は英数字・-・_ の16文字以上で、ROOM_TOKEN とは別の値にしてください。');
  process.exit(1);
}
const OWNER_BASE = OWNER_TOKEN ? '/r/' + OWNER_TOKEN : null;
const OWNER_LABEL = 'オーナー/家守';
const OWNER_NAME = '佐々木ユキオ';
// パスの先頭部分から、入居者用('tenant')かオーナー用('owner')かを判定
function roleOf(p) {
  if (p === BASE || p.startsWith(BASE + '/')) return { role: 'tenant', base: BASE };
  if (OWNER_BASE && (p === OWNER_BASE || p.startsWith(OWNER_BASE + '/'))) return { role: 'owner', base: OWNER_BASE };
  return null;
}
const ROOM_RE = /^(B-20[1-3]|P-20[1-6]) /;

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

// ---- 管理者への通知（Telegram / メール。どちらも任意・両方同時も可） ----
// Telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID（ほぼリアルタイム。連続投稿は5秒ごとにまとめる）
//   PUBLIC_URL（任意）: 例 https://xxxx.onrender.com  → 通知にチャットへのリンクを付ける
// メール: RESEND_API_KEY, NOTIFY_EMAIL（RenderはSMTPが使えないためResendのHTTP APIを使用）
//   NOTIFY_INTERVAL_MIN: メール通知の最短間隔（分, 既定10）
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_API_URL = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || '';
const NOTIFY_FROM = process.env.NOTIFY_FROM || '静岡用宗Ｂ邸ホワイトボード <onboarding@resend.dev>';
const RESEND_API_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const EMAIL_INTERVAL = Math.max(1, Number(process.env.NOTIFY_INTERVAL_MIN) || 10) * 60 * 1000;
const TELEGRAM_INTERVAL = Number(process.env.TELEGRAM_INTERVAL_SEC || 5) * 1000;
const EMAIL_DAILY_MAX = 90; // Resend無料枠(1日100通)を超えないための上限
const TELEGRAM_ENABLED = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
const EMAIL_ENABLED = !!(RESEND_API_KEY && NOTIFY_EMAIL);

function fmtJst(ts) {
  return new Date(ts).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
}
function fmtLine(m) {
  const t = m.text.trim().slice(0, 300);
  return `${m.name}: ${t}${m.image ? (t ? ' ' : '') + '(画像あり)' : ''}`;
}

// 最短間隔つきのまとめ送り。最初の1件はすぐ送り、間隔内の投稿は次の送信にまとめる。
function makeNotifier(intervalMs, send) {
  let pending = [];
  let timer = null;
  let lastAt = 0;
  async function flush() {
    timer = null;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    lastAt = Date.now();
    try {
      await send(batch);
    } catch (e) {
      console.error('通知に失敗:', e.message);
    }
  }
  return function push(m) {
    pending.push(m);
    if (timer) return;
    timer = setTimeout(flush, Math.max(0, lastAt + intervalMs - Date.now()));
  };
}

const telegramPush = TELEGRAM_ENABLED
  ? makeNotifier(TELEGRAM_INTERVAL, async (batch) => {
      const shown = batch.slice(-10);
      let text = shown.map(fmtLine).join('\n');
      if (batch.length > shown.length) text = `（ほか${batch.length - shown.length}件）\n` + text;
      if (PUBLIC_URL) text += `\n\n${PUBLIC_URL}${BASE}`;
      const r = await fetch(`${TELEGRAM_API_URL}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: text.slice(0, 4000),
          disable_web_page_preview: true,
        }),
      });
      if (!r.ok) console.error('Telegram通知に失敗:', r.status, (await r.text()).slice(0, 200));
    })
  : null;

let emailSent = { day: '', n: 0 };
const emailPush = EMAIL_ENABLED
  ? makeNotifier(EMAIL_INTERVAL, async (batch) => {
      const day = new Date().toISOString().slice(0, 10);
      if (emailSent.day !== day) emailSent = { day, n: 0 };
      if (emailSent.n >= EMAIL_DAILY_MAX) return;
      emailSent.n++;
      const subject =
        batch.length === 1
          ? `チャットに新しい投稿（${batch[0].name}さん）`
          : `チャットに新しい投稿が${batch.length}件あります`;
      const body = batch.map((m) => `[${fmtJst(m.ts)}] ${fmtLine(m)}`).join('\n\n');
      const r = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: NOTIFY_FROM, to: [NOTIFY_EMAIL], subject, text: body }),
      });
      if (!r.ok) console.error('メール通知に失敗:', r.status, (await r.text()).slice(0, 200));
    })
  : null;

function notifyAdmin(m) {
  if (telegramPush) telegramPush(m);
  if (emailPush) emailPush(m);
}

// ---- Google Drive への定期バックアップ（利用者には表示しない） ----
// Google Apps Script のウェブアプリ(GDRIVE_WEBHOOK_URL)へ、新しいメッセージと画像を送る。
const GDRIVE_WEBHOOK_URL = process.env.GDRIVE_WEBHOOK_URL || '';
const GDRIVE_SECRET = process.env.GDRIVE_SECRET || '';
const GDRIVE_INTERVAL_MIN = Math.max(5, Number(process.env.GDRIVE_INTERVAL_MIN) || 60);
const GDRIVE_ENABLED = !!(GDRIVE_WEBHOOK_URL && GDRIVE_SECRET);
const backedUp = new Set(); // 保存済みメッセージID（再起動後はGoogle側が重複を除外）
let backupRunning = false;

async function backupToDrive() {
  if (!GDRIVE_ENABLED || backupRunning) return;
  backupRunning = true;
  try {
    const pending = messages.filter((m) => !backedUp.has(m.id));
    for (let i = 0; i < pending.length; ) {
      // 1回の送信は、メッセージ最大200件・画像最大8枚・約12MBまで
      const batch = [];
      const images = [];
      let bytes = 0;
      while (i < pending.length && batch.length < 200) {
        const m = pending[i];
        let img = null;
        if (m.image) {
          try {
            const buf = await fs.promises.readFile(path.join(UPLOAD_DIR, m.image));
            img = { name: m.image, data: buf.toString('base64') };
          } catch (_) {} // 画像が既に無い場合はメッセージだけ保存
        }
        if (img && batch.length > 0 && (images.length >= 8 || bytes + img.data.length > 12 * 1024 * 1024)) break;
        batch.push(m);
        if (img) {
          images.push(img);
          bytes += img.data.length;
        }
        i++;
      }
      const res = await fetch(GDRIVE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ secret: GDRIVE_SECRET, messages: batch, images }),
        redirect: 'follow',
      });
      const j = await res.json().catch(() => null);
      if (!j || !j.ok) throw new Error('Drive応答エラー: ' + (j && j.error ? j.error : res.status));
      for (const m of batch) backedUp.add(m.id);
    }
    // 古いIDの掃除
    const live = new Set(messages.map((m) => m.id));
    for (const id of backedUp) if (!live.has(id)) backedUp.delete(id);
  } catch (e) {
    console.error('Driveバックアップ失敗（次回再試行）:', e.message); // ログのみ。画面には出さない
  } finally {
    backupRunning = false;
  }
}

// ---- HTTP ----
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const INDEX_OWNER = Buffer.from(INDEX.toString('utf8').replace('<body>', '<body data-role="owner">'));
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

  const rr = roleOf(p);
  if (!rr) return notFound(res);
  const base = rr.base;

  if (req.method === 'GET' && (p === base || p === base + '/')) {
    res.writeHead(
      200,
      baseHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      })
    );
    return res.end(rr.role === 'owner' ? INDEX_OWNER : INDEX);
  }

  if (req.method === 'GET' && p.startsWith(base + '/img/')) {
    const name = p.slice((base + '/img/').length);
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

  if (req.method === 'POST' && p === base + '/upload') {
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
  const rr = roleOf(p);
  if (!rr || p !== rr.base + '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.role = rr.role;
    wss.emit('connection', ws);
  });
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

    let name = String(d.name || '').trim().slice(0, MAX_NAME);
    if (ws.role === 'owner') {
      // オーナー/家守: 名前の頭にラベルをサーバー側で付ける（なりすまし防止）
      name = OWNER_LABEL + ' ' + OWNER_NAME; // オーナー用URLは名前も固定
    } else if (!ROOM_RE.test(name) || name.length <= 6) {
      return; // 入居者は部屋番号が必須
    }
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
    notifyAdmin(m);
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
  cleanup();
  if (GDRIVE_ENABLED) {
    setTimeout(backupToDrive, 60 * 1000);
    setInterval(backupToDrive, GDRIVE_INTERVAL_MIN * 60 * 1000);
  } // 起動時にも期限切れを掃除（wss初期化後に実行）
  console.log('チャットを起動しました。参加用URLのパス:');
  console.log('  入居者用: ' + BASE);
  console.log('  オーナー/家守用: ' + (OWNER_BASE || '（未設定。環境変数 OWNER_TOKEN を設定すると有効）'));
  console.log('  例: http://localhost:' + PORT + BASE);
  console.log('Telegram通知: ' + (TELEGRAM_ENABLED ? '有効' : '無効') + ' / メール通知: ' + (EMAIL_ENABLED ? '有効' : '無効') + ' / Driveバックアップ: ' + (GDRIVE_ENABLED ? GDRIVE_INTERVAL_MIN + '分ごと' : '無効'));
});
