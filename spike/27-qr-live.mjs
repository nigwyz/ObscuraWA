#!/usr/bin/env node
/**
 * 27 — live QR capture.
 *
 * Boots WhatsApp Web on the real bridge path (no getDeviceInfo fake), then
 * keeps the session alive and refreshes /tmp/ObscuraWA-qr-live.png every 2 s.
 * Scan the file with the phone; it is overwritten as WhatsApp rotates the QR.
 *
 * Only the screenshot is written; the QR payload is never logged or saved.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { ObscuraServer, connectPuppeteer, freePort } from './lib/obscura.mjs';
import { installWsBridge } from './lib/ws-bridge.mjs';
import { startMemoryKeeper } from './lib/memory-keeper.mjs';

process.env.OBSCURA_SCRIPT_DEADLINE_MS ??= '60000';
process.env.OBSCURA_MODULE_BUDGET_MS ??= '15000';

const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS ?? 180_000);
const QR_PATH = process.env.QR_PATH ?? '/tmp/ObscuraWA-qr-live.png';
const LOGIN_PATH = process.env.LOGIN_PATH ?? '/tmp/ObscuraWA-logged-in.png';
const resultsDir = new URL('../results/', import.meta.url).pathname;
const storageDir = `${resultsDir}storage-27`;
await mkdir(resultsDir, { recursive: true });
await rm(storageDir, { recursive: true, force: true });

const workerSource = await readFile(new URL('./lib/worker-polyfill.js', import.meta.url), 'utf8');
const wsShimSource = await readFile(new URL('./lib/ws-shim.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('./lib/wa-bridge.js', import.meta.url), 'utf8');

const port = await freePort();
const server = new ObscuraServer({ port, storageDir });
let browser;

async function snap(page) {
  return page.evaluate(() => {
    const qr =
      document.querySelector('div[data-testid="qrcode"]') ??
      document.querySelector('canvas[aria-label]') ??
      document.querySelector('canvas');
    return {
      hasQr: Boolean(qr),
      hasPaneSide: Boolean(document.querySelector('#pane-side')),
      scanText: (document.body?.innerText ?? '').includes('Scan to log in'),
      canvasCount: document.querySelectorAll('canvas').length,
      title: document.title,
    };
  });
}

async function saveQr(page) {
  const el = await page.$('canvas');
  if (!el) return false;
  const tmp = `${QR_PATH}.tmp.png`;
  try {
    await el.screenshot({ path: tmp });
    await rename(tmp, QR_PATH);
    return true;
  } catch (e) {
    // Fallback: whole-page screenshot clipped to the canvas box.
    try {
      const box = await el.boundingBox();
      if (!box) return false;
      await page.screenshot({ path: tmp, clip: box });
      await rename(tmp, QR_PATH);
      return true;
    } catch (e2) {
      console.error('qr capture failed:', String(e2.message || e2));
      return false;
    }
  }
}

try {
  await server.start();
  const connected = await connectPuppeteer(port, puppeteer);
  browser = connected.browser;
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  );

  const cdp = await page.createCDPSession();
  const bridge = await installWsBridge(page);
  await page.evaluateOnNewDocument(wsShimSource);
  await page.evaluateOnNewDocument(workerSource);
  await page.evaluateOnNewDocument(bridgeSource);

  page.on('pageerror', (e) => console.error('pageerror:', String(e.message || e).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('console:', m.text().slice(0, 200));
  });

  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const deadline = Date.now() + 45_000;
  let state;
  while (Date.now() < deadline) {
    state = await snap(page);
    if (state.hasQr || state.hasPaneSide) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!state?.hasQr && !state?.hasPaneSide) throw new Error('no QR within 45s');

  if (state.hasPaneSide) {
    console.log('already authenticated');
  } else {
    await saveQr(page);
    startMemoryKeeper(cdp, { intervalMs: 30_000, delayMs: 5_000 });
    console.log(`QR live: ${QR_PATH}`);
  }

  const t0 = Date.now();
  let lastSave = 0;
  while (Date.now() - t0 < KEEPALIVE_MS) {
    state = await snap(page);
    if (state.hasPaneSide) {
      await page.screenshot({ path: LOGIN_PATH }).catch(() => {});
      await writeFile('/tmp/ObscuraWA-status.txt', 'authenticated\n');
      console.log(`logged in: ${LOGIN_PATH}`);
      break;
    }
    if (state.hasQr && Date.now() - lastSave > 2000) {
      if (await saveQr(page)) lastSave = Date.now();
    }

    await new Promise((r) => setTimeout(r, 500));
  }
  if (!state?.hasPaneSide) {
    await writeFile('/tmp/ObscuraWA-status.txt', 'qr-expired\n');
    console.log('keepalive ended without login');
  }

  await bridge.dispose();
} catch (e) {
  console.error('FAILED:', String(e.stack || e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.disconnect().catch(() => {});
  await server.stop();
}
