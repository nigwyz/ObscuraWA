#!/usr/bin/env node
/**
 * 32 — QR with a raw CDP controller (no puppeteer-core).
 * Measures engine + controller PSS against the Puppeteer path.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { ObscuraServer, freePort } from './lib/obscura.mjs';
import { connectCdp } from './lib/cdp-client.mjs';
import { installWsBridgeRaw, WS_ADAPTER } from './lib/ws-bridge-raw.mjs';

process.env.OBSCURA_SCRIPT_DEADLINE_MS ??= '60000';
process.env.OBSCURA_MODULE_BUDGET_MS ??= '15000';

const resultsDir = new URL('../results/', import.meta.url).pathname;
const storageDir = `${resultsDir}storage-32`;
const QR_PATH = '/tmp/ObscuraWA-cdp-qr.png';
await mkdir(resultsDir, { recursive: true });
await rm(storageDir, { recursive: true, force: true });

const workerSource = await readFile(new URL('./lib/worker-polyfill.js', import.meta.url), 'utf8');
const wsShimSource = await readFile(new URL('./lib/ws-shim.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('./lib/wa-bridge.js', import.meta.url), 'utf8');

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

const out = { script: '32-qr-cdp', startedAt: new Date().toISOString() };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir });
let cdp;

try {
  await server.start();
  cdp = await connectCdp(port);
  const { sessionId } = await cdp.createPage();
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 700, deviceScaleFactor: 1, mobile: false,
  }, sessionId);

  const bridge = await installWsBridgeRaw(cdp, sessionId, { verbose: true });
  await cdp.addScript(sessionId, WS_ADAPTER);
  await cdp.addScript(sessionId, wsShimSource);
  await cdp.addScript(sessionId, workerSource);
  await cdp.addScript(sessionId, bridgeSource);

  cdp.on('Runtime.exceptionThrown', (p) => {
    if ((out.exceptions ||= []).length < 20) {
      out.exceptions.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 400));
    }
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error') return;
    const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300);
    if ((out.consoleErrors ||= []).length < 20) out.consoleErrors.push(text);
  });

  await cdp.navigate(sessionId, 'https://web.whatsapp.com/');

  const deadline = Date.now() + 45_000;
  let state = {};
  while (Date.now() < deadline) {
    state = await cdp.evaluate(sessionId, `(() => {
      const qr = document.querySelector('div[data-testid="qrcode"]') || document.querySelector('canvas');
      return {
        hasQr: !!qr,
        hasPaneSide: !!document.querySelector('#pane-side'),
        scan: (document.body?.innerText || '').includes('Scan to log in'),
        title: document.title,
      };
    })()`).catch(() => ({}));
    if (state.hasQr || state.hasPaneSide) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!state.hasQr && !state.hasPaneSide) throw new Error('no QR within 45s');

  const box = await cdp.evaluate(sessionId, `(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };
  })()`);
  if (box) {
    const png = await cdp.screenshot(sessionId, box);
    await writeFile(QR_PATH, png);
    out.qrPngBytes = png.length;
  }

  const atQr = {
    engine: await memTree(server.child.pid),
    total: await memTree(process.pid),
    heap: await cdp.heapUsage(sessionId).catch(() => null),
  };
  await cdp.collectGarbage(sessionId).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  const afterGc = {
    engine: await memTree(server.child.pid),
    total: await memTree(process.pid),
    heap: await cdp.heapUsage(sessionId).catch(() => null),
  };

  out.state = state;
  out.atQr = atQr;
  out.afterGc = afterGc;
  out.ws = bridge.stats;
  out.qrPath = QR_PATH;
  console.log('state:', JSON.stringify(state));
  console.log('QR:', QR_PATH, out.qrPngBytes, 'bytes');
  console.log(`QR      engine PSS ${atQr.engine.pssMb} MB | controller ${atQr.total.pssMb - atQr.engine.pssMb} MB | total ${atQr.total.pssMb} MB`);
  console.log(`afterGC engine PSS ${afterGc.engine.pssMb} MB | controller ${afterGc.total.pssMb - afterGc.engine.pssMb} MB | total ${afterGc.total.pssMb} MB`);
  console.log('ws:', JSON.stringify(out.ws));
  if (out.exceptions?.length) console.log('exceptions:', out.exceptions.slice(0, 3));

  bridge.dispose();
  cdp.close();
} catch (e) {
  out.error = String(e.stack || e);
  console.error('FAILED:', out.error);
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  await server.stop();
  await writeFile(`${resultsDir}32-qr-cdp.json`, JSON.stringify(out, null, 2)).catch(() => {});
}
