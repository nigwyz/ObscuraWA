#!/usr/bin/env node
/**
 * 29 — Obscura PSS baseline at the same state as 28:
 * headless, QR shown, +8 s, no screenshot polling.
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { ObscuraServer, connectPuppeteer, freePort, saveResult } from './lib/obscura.mjs';
import { installWsBridge } from './lib/ws-bridge.mjs';

process.env.OBSCURA_SCRIPT_DEADLINE_MS ??= '60000';
process.env.OBSCURA_MODULE_BUDGET_MS ??= '15000';

const resultsDir = new URL('../results/', import.meta.url).pathname;
const storageDir = `${resultsDir}storage-29`;
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
      byPid.set(pid, { ppid, rssKb: rss ? Number(rss[1]) : 0, pssKb: pss ? Number(pss[1]) : 0 });
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
  for (const pid of tree) {
    rssKb += byPid.get(pid)?.rssKb ?? 0;
    pssKb += byPid.get(pid)?.pssKb ?? 0;
  }
  return { rssMb: Math.round(rssKb / 1024), pssMb: Math.round(pssKb / 1024) };
}

const out = { script: '29-obscura-pss', samples: [] };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir });
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
  await page.evaluateOnNewDocument(wsShimSource);
  await page.evaluateOnNewDocument(workerSource);
  await page.evaluateOnNewDocument(bridgeSource);

  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const deadline = Date.now() + 45_000;
  let state = {};
  while (Date.now() < deadline) {
    state = await page.evaluate(() => {
      const qr = document.querySelector('div[data-testid="qrcode"]') ?? document.querySelector('canvas');
      return {
        hasQr: Boolean(qr),
        hasPaneSide: Boolean(document.querySelector('#pane-side')),
        scanText: (document.body?.innerText ?? '').includes('Scan to log in'),
      };
    });
    if (state.hasQr || state.hasPaneSide) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!state.hasQr && !state.hasPaneSide) throw new Error('no QR within 45s');

  const enginePid = server.child.pid;
  const sample = async (label) => {
    const total = await memTree(process.pid);
    const engine = await memTree(enginePid);
    const entry = {
      label,
      totalRssMb: total.rssMb,
      totalPssMb: total.pssMb,
      engineRssMb: engine.rssMb,
      enginePssMb: engine.pssMb,
      controllerPssMb: total.pssMb - engine.pssMb,
      controllerRssMb: total.rssMb - engine.rssMb,
    };
    out.samples.push(entry);
    return entry;
  };

  const atQr = await sample('qr');
  await new Promise((r) => setTimeout(r, 8000));
  const at8s = await sample('qr+8s');
  out.state = state.hasPaneSide ? 'authenticated' : state.hasQr ? 'qr-shown' : 'not-ready';
  out.qr = atQr;
  out.steady = at8s;
  console.log(
    `state=${out.state} | total PSS ${at8s.totalPssMb} MB (RSS ${at8s.totalRssMb}) | engine PSS ${at8s.enginePssMb} MB | controller PSS ${at8s.controllerPssMb} MB`,
  );

  await bridge.dispose();
} catch (e) {
  out.error = String(e.stack || e);
  console.error('FAILED:', out.error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.disconnect().catch(() => {});
  await server.stop();
  await saveResult(resultsDir, '29-obscura-pss.json', out);
}
