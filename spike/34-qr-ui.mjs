#!/usr/bin/env node
/**
 * 34 — tiny local QR UI.
 * Serves an auto-refreshing page around /tmp/ObscuraWA-qr-live.png.
 * Open http://127.0.0.1:<port>/ and scan with the phone.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const QR = process.env.QR_PATH ?? '/tmp/ObscuraWA-qr-live.png';
const LOGIN = process.env.LOGIN_PATH ?? '/tmp/ObscuraWA-logged-in.png';
const STATUS = '/tmp/ObscuraWA-status.txt';
const wantedPort = Number(process.env.UI_PORT ?? 8787);

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ObscuraWA — WhatsApp QR</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    background:#0b141a; color:#e9edef;
    font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .card { width:min(92vw,420px); padding:28px; border-radius:20px;
    background:#111b21; box-shadow:0 20px 60px rgba(0,0,0,.45); text-align:center; }
  h1 { font-size:20px; margin:0 0 6px; font-weight:600; }
  p { margin:0; color:#8696a0; font-size:13px; }
  .qrwrap { margin:22px auto; width:min(78vw,320px); aspect-ratio:1;
    background:#fff; border-radius:14px; padding:12px; display:grid; place-items:center; }
  #qr { width:100%; height:100%; object-fit:contain; display:block; }
  .pill { display:inline-flex; align-items:center; gap:7px; margin-top:6px;
    padding:7px 12px; border-radius:999px; background:#202c33; font-size:12px; color:#aebac1; }
  .dot { width:8px; height:8px; border-radius:50%; background:#f59e0b; }
  .dot.live { background:#25d366; box-shadow:0 0 0 4px rgba(37,211,102,.12); }
  .dot.ok { background:#25d366; }
  .steps { margin:18px 0 0; text-align:left; color:#8696a0; font-size:12px; }
  .steps div { margin:6px 0; }
  .steps b { color:#e9edef; font-weight:500; }
  #login { display:none; margin-top:16px; width:100%; border-radius:12px; }
  .ok h1 { color:#25d366; }
</style></head>
<body><div class="card" id="card">
  <h1 id="title">Scan to link this device</h1>
  <p id="sub">WhatsApp → Settings → Linked devices → Link a device</p>
  <div class="qrwrap"><img id="qr" alt="WhatsApp QR code"></div>
  <div class="pill"><span class="dot" id="dot"></span><span id="status">waiting for QR…</span></div>
  <div class="steps">
    <div><b>1.</b> Open WhatsApp on your phone</div>
    <div><b>2.</b> Tap <b>Linked devices</b> → <b>Link a device</b></div>
    <div><b>3.</b> Point the camera at this QR</div>
  </div>
  <img id="login" alt="Logged in">
</div>
<script>
  const img = document.getElementById('qr');
  const dot = document.getElementById('dot');
  const statusEl = document.getElementById('status');
  const title = document.getElementById('title');
  const sub = document.getElementById('sub');
  const login = document.getElementById('login');
  let lastMtime = 0;
  let authenticated = false;

  async function refresh() {
    if (authenticated) return;
    try {
      const r = await fetch('/status?t=' + Date.now(), { cache: 'no-store' }).then(r => r.json());
      if (r.authenticated) {
        authenticated = true;
        document.getElementById('card').classList.add('ok');
        title.textContent = 'Logged in';
        sub.textContent = 'This device is now linked.';
        statusEl.textContent = 'authenticated';
        dot.className = 'dot ok';
        login.src = '/login.png?t=' + Date.now();
        login.style.display = 'block';
        return;
      }
      if (r.qr && r.mtime !== lastMtime) {
        const next = new Image();
        next.onload = () => { img.src = next.src; };
        next.src = '/qr.png?t=' + r.mtime;
        lastMtime = r.mtime;
        dot.className = 'dot live';
        statusEl.textContent = 'QR live — scan now';
      } else if (!r.qr) {
        dot.className = 'dot';
        statusEl.textContent = r.expired ? 'QR expired' : 'waiting for QR…';
      }
    } catch (e) { /* retry */ }
  }
  refresh();
  setInterval(refresh, 1000);
</script></body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
      return;
    }
    if (url.pathname === '/qr.png') {
      const buf = await readFile(QR);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(buf);
      return;
    }
    if (url.pathname === '/login.png') {
      const buf = await readFile(LOGIN);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(buf);
      return;
    }
    if (url.pathname === '/status') {
      let qr = false, mtime = 0, expired = false, statusText = '';
      try { const s = await stat(QR); qr = true; mtime = Math.round(s.mtimeMs); } catch { /* none */ }
      try { statusText = (await readFile(STATUS, 'utf8')).trim(); } catch { /* none */ }
      expired = statusText === 'qr-expired';
      const authenticated = statusText === 'authenticated';
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ qr, mtime, expired, authenticated, statusText }));
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('QR not ready yet');
  }
});

function listen(port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

let port;
try {
  port = await listen(wantedPort);
} catch {
  port = await listen(0);
}
const ui = `http://127.0.0.1:${port}/`;
console.log(`QR UI: ${ui}`);
if (process.env.OPEN_UI === '1') {
  spawn('xdg-open', [ui], { detached: true, stdio: 'ignore' }).unref();
}
