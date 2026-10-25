#!/usr/bin/env node
/**
 * 33 — live QR with the raw CDP controller.
 * No Puppeteer. Refreshes /tmp/ObscuraWA-qr-live.png every 2 s, GC every 30 s,
 * exits on login or keepalive expiry.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { ObscuraServer, freePort } from './lib/obscura.mjs';
import { connectCdp } from './lib/cdp-client.mjs';
import { installWsBridgeRaw, WS_ADAPTER } from './lib/ws-bridge-raw.mjs';
import { startMemoryKeeper } from './lib/memory-keeper.mjs';

process.env.OBSCURA_SCRIPT_DEADLINE_MS ??= '60000';
process.env.OBSCURA_MODULE_BUDGET_MS ??= '15000';

const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS ?? 300_000);
const QR_PATH = process.env.QR_PATH ?? '/tmp/ObscuraWA-qr-live.png';
const WS_STATE = '/tmp/ObscuraWA-ws.json';
const LOGIN_PATH = process.env.LOGIN_PATH ?? '/tmp/ObscuraWA-logged-in.png';
const resultsDir = new URL('../results/', import.meta.url).pathname;
const storageDir = `${resultsDir}storage-33`;
await mkdir(resultsDir, { recursive: true });
if (process.env.KEEP_STORAGE !== '1') {
  await rm(storageDir, { recursive: true, force: true });
}

const workerSource = await readFile(new URL('./lib/worker-polyfill.js', import.meta.url), 'utf8');
const wsShimSource = await readFile(new URL('./lib/ws-shim.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('./lib/wa-bridge.js', import.meta.url), 'utf8');
const handlerChunkFile = process.env.HANDLER_CHUNK_FILE;
const handlerChunkSource = handlerChunkFile ? await readFile(handlerChunkFile, 'utf8') : null;

async function memTree(rootPid) {
  const { readdir } = await import('node:fs/promises');
  const pids = (await readdir('/proc')).filter((e) => /^\d+$/.test(e)).map(Number);
  const byPid = new Map();
  for (const pid of pids) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const rss = status.match(/^VmRSS:\s+(\d+) kB/m);
      const rollup = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
      const pss = rollup.match(/^Pss:\s+(\d+) kB/m);
      byPid.set(pid, { ppid, rssKb: rss ? Number(rss[1]) : 0, pssKb: pss ? Number(pss[1]) : 0 });
    } catch { /* gone */ }
  }
  const tree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, i] of byPid) {
      if (!tree.has(pid) && tree.has(i.ppid)) { tree.add(pid); grew = true; }
    }
  }
  let rssKb = 0, pssKb = 0;
  for (const pid of tree) {
    rssKb += byPid.get(pid)?.rssKb ?? 0;
    pssKb += byPid.get(pid)?.pssKb ?? 0;
  }
  return { rssMb: Math.round(rssKb / 1024), pssMb: Math.round(pssKb / 1024) };
}

const out = { script: '33-qr-live-cdp', startedAt: new Date().toISOString() };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir });
let cdp;

const stateExpr = `(() => {
  const qr = document.querySelector('div[data-testid="qrcode"]') || document.querySelector('canvas');
  const r = qr ? qr.getBoundingClientRect() : null;
  const qrVisible = !!(r && r.width > 10 && r.height > 10);
  const text = document.body?.innerText || '';
  const scan = text.includes('Scan to log in');
  const chatList = !!document.querySelector('#side, #pane-side, [data-testid="chat-list"], div[aria-label="Chat list"]');
  const authenticated = !qrVisible && !scan && (chatList || text.includes('Loading your chats'));
  const ready = authenticated && chatList;
  return {
    hasQr: qrVisible,
    scan: scan,
    chatList: chatList,
    authenticated: authenticated,
    ready: ready,
    hasPaneSide: !!document.querySelector('#pane-side'),
    bridgeStatus: window.__waBridgeStatus || null,
    bridgeErrors: (window.__waBridgeErrors || []).slice(0, 4),
    namespaces: (window.__waBridge && window.__waBridge.getHandledNamespaces)
      ? window.__waBridge.getHandledNamespaces()
      : null,
    title: document.title,
    text: text.slice(0, 240),
  };
})()`;

const boxExpr = `(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };
})()`;

try {
  await server.start();
  cdp = await connectCdp(port);
  const { sessionId } = await cdp.createPage();
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 700, deviceScaleFactor: 1, mobile: false,
  }, sessionId);

  const bridge = await installWsBridgeRaw(cdp, sessionId);
  await cdp.addScript(sessionId, WS_ADAPTER);
  await cdp.addScript(sessionId, wsShimSource);
  await cdp.addScript(sessionId, workerSource);
  if (handlerChunkSource) {
    await cdp.addScript(
      sessionId,
      `window.__waHandlerChunkSource = ${JSON.stringify(handlerChunkSource)};`,
    );
  }
  await cdp.addScript(sessionId, bridgeSource);

  cdp.on('Runtime.exceptionThrown', (p) => {
    if ((out.exceptions ||= []).length < 40) {
      out.exceptions.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 300));
    }
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'warning') return;
    const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300);
    if ((out.consoleErrors ||= []).length < 60) out.consoleErrors.push({ type: p.type, text });
  });

  await cdp.navigate(sessionId, 'https://web.whatsapp.com/');

  const deadline = Date.now() + Number(process.env.QR_TIMEOUT_MS ?? 90_000);
  let state = {};
  while (Date.now() < deadline) {
    state = await cdp.evaluate(sessionId, stateExpr).catch(() => ({}));
    if (state.hasQr || state.authenticated) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!state.hasQr && !state.authenticated) {
    out.timeoutState = await cdp
      .evaluate(
        sessionId,
        `(() => ({
          readyState: document.readyState,
          canvases: document.querySelectorAll('canvas').length,
          images: document.querySelectorAll('img').length,
          qrNodes: document.querySelectorAll('[data-testid="qrcode"]').length,
          text: (document.body?.innerText || '').slice(0, 500),
        }))()`,
      )
      .catch(() => null);
    const png = await cdp.screenshot(sessionId).catch(() => null);
    if (png) await writeFile('/tmp/ObscuraWA-33-timeout.png', png);
    throw new Error(`no QR within ${process.env.QR_TIMEOUT_MS ?? 90_000}ms`);
  }

  const saveQr = async () => {
    const box = await cdp.evaluate(sessionId, boxExpr).catch(() => null);
    if (!box || !box.width) return false;
    const png = await cdp.screenshot(sessionId, box).catch(() => null);
    if (!png) return false;
    await writeFile(`${QR_PATH}.tmp`, png);
    await import('node:fs/promises').then((fs) => fs.rename(`${QR_PATH}.tmp`, QR_PATH));
    return true;
  };

  await writeFile(WS_STATE, JSON.stringify({ at: Date.now(), stats: bridge.stats })).catch(() => {});
  if (!state.authenticated) {
    await saveQr();
    await writeFile('/tmp/ObscuraWA-status.txt', 'qr-live\n');
    console.log(`QR live: ${QR_PATH}`);
    startMemoryKeeper(cdp, { intervalMs: 30_000, delayMs: 5_000 });
  }

  if (handlerChunkSource) {
    out.handlerChunk = await cdp
      .evaluate(
        sessionId,
        `(() => {
          if (!window.__waHandlerChunkInjected) {
            const script = document.createElement('script');
            script.textContent = ${JSON.stringify(handlerChunkSource)};
            document.head.appendChild(script);
            window.__waHandlerChunkInjected = true;
            window.__waHandlerChunkStatus = 'fallback';
          }
          return {
            status: window.__waHandlerChunkStatus || null,
            handler: (() => {
              try { return typeof window.require('WAWebSetFrontendHandlerApi') === 'object'; }
              catch (e) { return false; }
            })(),
            deviceInfo: (() => {
              try { return typeof window.require('WAWebDeviceInfoBridgeApi') === 'object'; }
              catch (e) { return false; }
            })(),
          };
        })()`,
      )
      .catch((e) => ({ error: String(e.message || e) }));
    console.log('handler chunk:', JSON.stringify(out.handlerChunk));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (process.env.SPIKE_FULL_BRIDGE !== '0') {
    const full = await cdp.evaluate(
      sessionId,
      'window.__waInstallFullBridge ? window.__waInstallFullBridge() : "missing"',
    ).catch((e) => `eval-error: ${e.message}`);
    console.log('full bridge:', full);
  }

  const engineAtQr = await memTree(server.child.pid);
  const totalAtQr = await memTree(process.pid);
  console.log(`QR engine PSS ${engineAtQr.pssMb} MB | controller ${totalAtQr.pssMb - engineAtQr.pssMb} MB | total ${totalAtQr.pssMb} MB`);

  const t0 = Date.now();
  let lastSave = 0;
  let lastDiag = 0;
  let authLogged = false;
  while (Date.now() - t0 < KEEPALIVE_MS) {
    state = await cdp.evaluate(sessionId, stateExpr).catch(() => ({}));
    await writeFile('/tmp/ObscuraWA-state.json', JSON.stringify({ at: Date.now(), state })).catch(() => {});
    await writeFile(WS_STATE, JSON.stringify({ at: Date.now(), stats: bridge.stats })).catch(() => {});
    if (state.authenticated && !authLogged) {
      authLogged = true;
      const full = await cdp.evaluate(
        sessionId,
        'window.__waInstallFullBridge ? window.__waInstallFullBridge() : "missing"',
      ).catch((e) => `eval-error: ${e.message}`);
      console.log('full bridge retry:', full);
      const png = await cdp.screenshot(sessionId).catch(() => null);
      if (png) await writeFile('/tmp/ObscuraWA-auth.png', png);
      await writeFile('/tmp/ObscuraWA-status.txt', 'authenticated\n');
      console.log('authenticated; waiting for the chat list');
    }
    if (Date.now() - lastDiag > 2000) {
      lastDiag = Date.now();
      const worker = await cdp.evaluate(sessionId, `(() => {
        const d = window.__obscuraWorkerPolyfill;
        if (!d) return null;
        return {
          created: d.createdMeta,
          errors: d.errors,
          rejections: d.rejections,
          messages: d.messages,
          posts: d.posts,
          hrp: d.hrp,
        };
      })()`).catch(() => null);
      await writeFile('/tmp/ObscuraWA-worker.json', JSON.stringify({ at: Date.now(), worker })).catch(() => {});
      await writeFile('/tmp/ObscuraWA-console.json', JSON.stringify({
        at: Date.now(),
        exceptions: out.exceptions || [],
        consoleErrors: out.consoleErrors || [],
      })).catch(() => {});
    }
    if (state.ready) {
      const png = await cdp.screenshot(sessionId).catch(() => null);
      if (png) await writeFile(LOGIN_PATH, png);
      await writeFile('/tmp/ObscuraWA-status.txt', 'ready\n');
      const engine = await memTree(server.child.pid);
      const total = await memTree(process.pid);
      console.log(`ready: ${LOGIN_PATH}`);
      console.log(`logged-in engine PSS ${engine.pssMb} MB | total ${total.pssMb} MB`);
      break;
    }
    if (state.hasQr && Date.now() - lastSave > 2000) {
      if (await saveQr()) lastSave = Date.now();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!state.ready) {
    await writeFile('/tmp/ObscuraWA-status.txt', state.authenticated ? 'authenticated\n' : 'qr-expired\n');
    console.log(state.authenticated ? 'keepalive ended after auth without ready' : 'keepalive ended without login');
  }

  bridge.dispose();
  cdp.close();
} catch (e) {
  out.error = String(e.stack || e);
  console.error('FAILED:', out.error);
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  await server.stop();
  await writeFile(`${resultsDir}33-qr-live-cdp.json`, JSON.stringify(out, null, 2)).catch(() => {});
}
