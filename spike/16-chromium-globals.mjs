#!/usr/bin/env node
/**
 * Reference snapshot: the globals WhatsApp Web sees inside a working Chromium.
 * Used only as the comparison column for the Obscura boot diagnosis in 13.
 *
 * No phone needed: stops at the QR.
 */
import puppeteer from 'puppeteer-core';

const CHROME_PATH =
  process.env.CHROME_PATH ??
  `${process.env.HOME}/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome`;
const out = { script: '16-chromium-globals' };
const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  // Match the UA whatsapp-web.js uses; WhatsApp serves a stripped legacy page
  // to unrecognized/headless UAs.
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  );
  const t0 = Date.now();
  await page.goto('https://web.whatsapp.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  });
  // Wait for the QR, which is the marker that the app finished booting.
  await page
    .waitForFunction(() => Boolean(document.querySelector('canvas')), { timeout: 90_000 })
    .catch(() => {});
  out.msToQrOrTimeout = Date.now() - t0;

  out.page = await page.evaluate(() => ({
    debugVersion: window.Debug?.VERSION ?? null,
    require: typeof window.require,
    webpackChunkbuild: typeof window.webpackChunkbuild,
    webpackChunk: typeof window.webpackChunk,
    hasQrCanvas: Boolean(document.querySelector('canvas')),
    hasPaneSide: Boolean(document.querySelector('#pane-side')),
    bodyHtmlLength: document.body?.innerHTML?.length ?? -1,
    title: document.title,
    locks: typeof navigator.locks,
    caches: typeof window.caches,
    swGetRegistration: typeof navigator.serviceWorker?.getRegistration,
  }));

  // Worker capability report, identical source to spike/13.
  out.worker = await workerReport(page);

  // The blob: worker above can be blocked by web.whatsapp.com CSP in Chromium,
  // so probe a CSP-free origin too; that is the honest engine comparison.
  const plain = await browser.newPage();
  await plain.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  );
  await plain.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  out.workerExampleCom = await workerReport(plain);
} catch (err) {
  out.error = String(err.stack || err);
} finally {
  await browser.close();
  const { mkdir, writeFile } = await import('node:fs/promises');
  const resultsDir = new URL('../results/', import.meta.url).pathname;
  await mkdir(resultsDir, { recursive: true });
  const path = `${resultsDir}16-chromium-globals.json`;
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  console.log(`saved ${path}`);
}

/** Same capability probe spike/13 uses on Obscura, so the columns line up. */
function workerReport(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const src = `
          const report = {
            isWorker: typeof self !== 'undefined',
            importScripts: typeof importScripts,
            navigator: typeof navigator,
            locks: typeof (self.navigator && self.navigator.locks),
            storage: typeof (self.navigator && self.navigator.storage),
            indexedDB: typeof indexedDB,
            caches: typeof caches,
            removeEventListener: typeof self.removeEventListener,
            addEventListener: typeof self.addEventListener,
            fetch: typeof fetch,
            WebSocket: typeof WebSocket,
            WebAssembly: typeof WebAssembly,
            crypto: typeof crypto,
            postMessage: typeof self.postMessage,
            location: typeof (self.location && self.location.href),
            workerGlobalSelf: String(typeof self),
          };
          self.postMessage(JSON.stringify(report));
        `;
        try {
          const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
          const w = new Worker(url);
          w.onmessage = (ev) => resolve({ raw: String(ev.data) });
          w.onerror = (ev) => resolve({ error: String(ev.message || 'worker error') });
          setTimeout(() => resolve({ error: 'timeout after 8s' }), 8000);
        } catch (e) {
          resolve({ threw: String(e) });
        }
      }),
  );
}
