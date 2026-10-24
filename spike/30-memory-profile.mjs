#!/usr/bin/env node
/**
 * 30 — memory profile at QR.
 *
 * Separates V8 heap from process RSS/PSS, records worker duplication and DOM
 * size, then forces a V8 GC and samples again. Run with different
 * PROFILE_V8_FLAGS to find the lowest stable heap limit.
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { ObscuraServer, connectPuppeteer, freePort, saveResult } from './lib/obscura.mjs';
import { installWsBridge } from './lib/ws-bridge.mjs';

process.env.OBSCURA_SCRIPT_DEADLINE_MS ??= '60000';
process.env.OBSCURA_MODULE_BUDGET_MS ??= '15000';

const label = process.env.PROFILE_LABEL ?? 'default';
const v8Flags = process.env.PROFILE_V8_FLAGS ?? '';
const resultsDir = new URL('../results/', import.meta.url).pathname;
const storageDir = `${resultsDir}storage-30-${label}`;
await mkdir(resultsDir, { recursive: true });
await rm(storageDir, { recursive: true, force: true });

const workerSource = await readFile(new URL('./lib/worker-polyfill.js', import.meta.url), 'utf8');
const wsShimSource = await readFile(new URL('./lib/ws-shim.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('./lib/wa-bridge.js', import.meta.url), 'utf8');

async function memTree(rootPid) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir('/proc');
  const byPid = new Map();
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const rss = status.match(/^VmRSS:\s+(\d+) kB/m);
      const rollup = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
      const pss = rollup.match(/^Pss:\s+(\d+) kB/m);
      const pssAnon = rollup.match(/^Pss_Anon:\s+(\d+) kB/m);
      const pssFile = rollup.match(/^Pss_File:\s+(\d+) kB/m);
      byPid.set(pid, {
        ppid,
        rssKb: rss ? Number(rss[1]) : 0,
        pssKb: pss ? Number(pss[1]) : 0,
        pssAnonKb: pssAnon ? Number(pssAnon[1]) : 0,
        pssFileKb: pssFile ? Number(pssFile[1]) : 0,
      });
    } catch {
      /* gone */
    }
  }
  const tree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, i] of byPid) {
      if (!tree.has(pid) && tree.has(i.ppid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  let rssKb = 0;
  let pssKb = 0;
  let pssAnonKb = 0;
  let pssFileKb = 0;
  for (const pid of tree) {
    rssKb += byPid.get(pid)?.rssKb ?? 0;
    pssKb += byPid.get(pid)?.pssKb ?? 0;
    pssAnonKb += byPid.get(pid)?.pssAnonKb ?? 0;
    pssFileKb += byPid.get(pid)?.pssFileKb ?? 0;
  }
  return {
    rssMb: Math.round(rssKb / 1024),
    pssMb: Math.round(pssKb / 1024),
    pssAnonMb: Math.round(pssAnonKb / 1024),
    pssFileMb: Math.round(pssFileKb / 1024),
  };
}

async function topMappings(pid, limit = 25) {
  const text = await readFile(`/proc/${pid}/smaps`, 'utf8');
  const blocks = text.split(/\n(?=[0-9a-f]+-)/);
  const rows = [];
  for (const b of blocks) {
    const head = b.split('\n')[0];
    const pss = b.match(/^Pss:\s+(\d+) kB/m);
    if (!pss) continue;
    rows.push({ map: head.slice(0, 140), pssKb: Number(pss[1]) });
  }
  rows.sort((a, b) => b.pssKb - a.pssKb);
  return rows.filter((r) => r.pssKb > 0).slice(0, limit).map((r) => ({
    map: r.map,
    pssMb: Math.round((r.pssKb / 1024) * 10) / 10,
  }));
}

const out = { script: '30-memory-profile', label, v8Flags, samples: [] };
const port = await freePort();
const server = new ObscuraServer({
  port,
  storageDir,
  globalArgs: v8Flags ? ['--v8-flags', v8Flags] : [],
});
let browser;

try {
  await server.start();
  const connected = await connectPuppeteer(port, puppeteer);
  browser = connected.browser;
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  );

  const bridge = await installWsBridge(page);
  const noWorkers = (process.env.PROFILE_NO_WORKERS ?? '').split(',').filter(Boolean);
  await page.evaluateOnNewDocument(
    'window.__obscuraNoWorkers = ' + JSON.stringify(noWorkers) + ';',
  );
  await page.evaluateOnNewDocument(wsShimSource);
  await page.evaluateOnNewDocument(workerSource);
  await page.evaluateOnNewDocument(bridgeSource);

  const cdp = await page.createCDPSession();
  const blocked = (process.env.PROFILE_BLOCK ?? '').split(',').filter(Boolean);
  if (blocked.length) {
    await cdp.send('Network.enable').catch(() => {});
    await cdp.send('Network.setBlockedURLs', { urls: blocked }).catch((e) => {
      out.blockError = String(e.message || e);
    });
  }

  // Engine + empty browsing context baseline, before WhatsApp loads.
  const preNav = await (async () => {
    const total = await memTree(process.pid);
    const engine = await memTree(server.child.pid);
    let heap = null;
    try { heap = await cdp.send('Runtime.getHeapUsage'); } catch (e) { /* optional */ }
    const entry = {
      name: 'pre-nav',
      engineRssMb: engine.rssMb,
      enginePssMb: engine.pssMb,
      enginePssAnonMb: engine.pssAnonMb,
      enginePssFileMb: engine.pssFileMb,
      totalPssMb: total.pssMb,
      controllerPssMb: total.pssMb - engine.pssMb,
      heapUsedMb: heap ? Math.round(heap.usedSize / 1024 / 1024) : null,
      heapTotalMb: heap ? Math.round(heap.totalSize / 1024 / 1024) : null,
      heapExternalMb: heap && heap.backingStorageSize != null ? Math.round(heap.backingStorageSize / 1024 / 1024) : null,
      workers: 0,
      domNodes: 0,
    };
    out.samples.push(entry);
    return entry;
  })();
  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const deadline = Date.now() + 45_000;
  let state = {};
  while (Date.now() < deadline) {
    state = await page.evaluate(() => {
      const qr = document.querySelector('div[data-testid="qrcode"]') ?? document.querySelector('canvas');
      return {
        hasQr: Boolean(qr),
        hasPaneSide: Boolean(document.querySelector('#pane-side')),
      };
    });
    if (state.hasQr || state.hasPaneSide) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!state.hasQr && !state.hasPaneSide) throw new Error('no QR within 45s');
  const qrAt = Date.now();

  const sample = async (name) => {
    const total = await memTree(process.pid);
    const engine = await memTree(server.child.pid);
    let heap = null;
    let heapError = null;
    try {
      heap = await cdp.send('Runtime.getHeapUsage');
    } catch (e) {
      heapError = String(e.message || e);
    }
    const pageStats = await page.evaluate(() => ({
      workers: window.__obscuraWorkerPolyfill?.created?.length ?? 0,
      reused: window.__obscuraWorkerPolyfill?.reused ?? 0,
      workerUrls: (window.__obscuraWorkerPolyfill?.created ?? []).slice(0, 10),
      workerMeta: (window.__obscuraWorkerPolyfill?.createdMeta ?? []).slice(0, 10),
      inlined: window.__obscuraWorkerPolyfill?.inlined?.length ?? 0,
      inlinedUrls: (window.__obscuraWorkerPolyfill?.inlined ?? []).slice(0, 10),
      sources: window.__obscuraWorkerPolyfill?.sources?.length ?? 0,
      domNodes: document.querySelectorAll('*').length,
      canvases: document.querySelectorAll('canvas').length,
      text: (document.body?.innerText ?? '').length,
    }));
    const entry = {
      name,
      atMs: Date.now() - qrAt,
      engineRssMb: engine.rssMb,
      enginePssMb: engine.pssMb,
      enginePssAnonMb: engine.pssAnonMb,
      enginePssFileMb: engine.pssFileMb,
      totalPssMb: total.pssMb,
      controllerPssMb: total.pssMb - engine.pssMb,
      heapUsedMb: heap ? Math.round(heap.usedSize / 1024 / 1024) : null,
      heapTotalMb: heap ? Math.round(heap.totalSize / 1024 / 1024) : null,
      heapExternalMb: heap && heap.backingStorageSize != null ? Math.round(heap.backingStorageSize / 1024 / 1024) : null,
      heapError,
      ...pageStats,
    };
    out.samples.push(entry);
    return entry;
  };

  const qrSample = await sample('qr');
  out.mappings = await topMappings(server.child.pid, 30).catch(() => null);
  await new Promise((r) => setTimeout(r, 10_000));
  await sample('qr+10s');
  try {
    await cdp.send('HeapProfiler.collectGarbage');
  } catch (e) {
    out.gcError = String(e.message || e);
  }
  await new Promise((r) => setTimeout(r, 1000));
  await sample('after-gc');

  out.state = state.hasPaneSide ? 'authenticated' : 'qr-shown';
  out.bootMs = qrAt - (qrAt - 0);
  console.log(
    out.samples
      .map(
        (s) =>
          `${s.name.padEnd(9)} engine PSS ${String(s.enginePssMb).padStart(4)} MB | total ${String(s.totalPssMb).padStart(4)} MB | V8 used ${String(s.heapUsedMb).padStart(4)} / total ${String(s.heapTotalMb).padStart(4)} MB | workers ${s.workers}`,
      )
      .join('\n'),
  );

  await bridge.dispose();
} catch (e) {
  out.error = String(e.stack || e);
  console.error('FAILED:', out.error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.disconnect().catch(() => {});
  await server.writeLogs(`${resultsDir}30-${label}.log`).catch(() => {});
  await server.stop();
  await saveResult(resultsDir, `30-memory-profile-${label}.json`, out);
}
