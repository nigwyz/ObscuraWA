#!/usr/bin/env node
/**
 * G1 diagnosis — why WhatsApp Web does not reach a QR inside Obscura.
 *
 * Captures the page's real failure signals (worker capabilities, script
 * loading, globals the app needs) instead of guessing.
 *
 * No phone needed.
 */
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import {
  ObscuraServer,
  connectPuppeteer,
  freePort,
  saveResult,
} from './lib/obscura.mjs';

process.env.OBSCURA_SCRIPT_DEADLINE_MS ??= '60000';
process.env.OBSCURA_MODULE_BUDGET_MS ??= '15000';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const out = { script: '13-ww-boot-blockers' };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-13` });

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();

  const consoleSeen = new Map();
  page.on('console', (msg) => {
    const key = `${msg.type()}: ${msg.text().slice(0, 250)}`;
    consoleSeen.set(key, (consoleSeen.get(key) ?? 0) + 1);
  });
  const pageErrors = [];
  page.on('pageerror', (err) =>
    pageErrors.push(String(err.stack || err.message || err).slice(0, 600)),
  );
  const failed = [];
  page.on('requestfailed', (req) =>
    failed.push({ url: req.url().slice(0, 160), error: req.failure()?.errorText }),
  );

  await page.goto('https://web.whatsapp.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  });
  await new Promise((r) => setTimeout(r, 25_000));

  out.pageState = await page.evaluate(() => {
    const scripts = [...document.querySelectorAll('script')];
    const resources = performance.getEntriesByType('resource');
    const js = resources.filter((r) => r.name.endsWith('.js') || r.initiatorType === 'script');
    const ws = resources.filter((r) => r.name.startsWith('ws') || r.name.includes('/ws'));
    return {
      title: document.title,
      appNode: Boolean(document.querySelector('#app')),
      bodyHtmlLength: document.body?.innerHTML?.length ?? -1,
      bodyHtmlHead: (document.body?.innerHTML ?? '').slice(0, 400),
      scriptTags: scripts.length,
      scriptSrcSample: scripts.map((s) => s.src.slice(-60)).slice(0, 12),
      jsResourcesLoaded: js.length,
      jsResourceNames: js.map((r) => r.name.slice(-70)).slice(0, 25),
      wsResources: ws.length,
      totalResources: resources.length,
      globals: {
        webpackChunkbuild: typeof window.webpackChunkbuild,
        webpackChunk: typeof window.webpackChunk,
        Debug: typeof window.Debug,
        require: typeof window.require,
        WWebJS: typeof window.WWebJS,
        wpp: typeof window.WPP,
        removeEventListener: typeof window.removeEventListener,
        locks: typeof navigator.locks,
        storagePersist: typeof navigator.storage?.persist,
        caches: typeof window.caches,
        serviceWorker: typeof navigator.serviceWorker,
        swRegister: typeof navigator.serviceWorker?.register,
        swGetRegistration: typeof navigator.serviceWorker?.getRegistration,
        dcb: typeof window.document?.addEventListener,
      },
    };
  });

  // Worker capability report, delivered through the same path a real app uses.
  out.worker = await page.evaluate(
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
          w.onerror = (ev) =>
            resolve({ error: String(ev.message || 'worker error'), filename: ev.filename });
          setTimeout(() => resolve({ error: 'timeout after 8s' }), 8000);
        } catch (e) {
          resolve({ threw: String(e) });
        }
      }),
  );

  // Does `importScripts` work at all when loading a same-origin script URL?
  out.importScriptsProbe = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const src = "self.postMessage('dependent:' + typeof self.DEP);";
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const w = new Worker(url);
        w.onmessage = (ev) => resolve({ note: 'postMessage path only', data: String(ev.data) });
        w.onerror = (ev) => resolve({ error: String(ev.message || 'error') });
        setTimeout(() => resolve({ error: 'timeout' }), 8000);
      }),
  );

  out.console = [...consoleSeen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([text, n]) => ({ n, text }));
  out.pageErrors = pageErrors;
  out.failedRequests = failed.slice(0, 25);

  const g = out.pageState?.globals ?? {};
  console.log(
    [
      `body html length: ${out.pageState?.bodyHtmlLength}  app node: ${out.pageState?.appNode}`,
      `script tags: ${out.pageState?.scriptTags}  js resources: ${out.pageState?.jsResourcesLoaded}  total: ${out.pageState?.totalResources}`,
      `webpackChunkbuild: ${g.webpackChunkbuild}  Debug: ${g.Debug}  require: ${g.require}`,
      `worker report: ${out.worker.raw ?? JSON.stringify(out.worker)}`,
      `page errors: ${pageErrors.length}  failed requests: ${failed.length}`,
      '',
      'top console messages:',
      ...out.console.slice(0, 12).map((c) => `  x${c.n} ${c.text}`),
      '',
      'page errors (first 3):',
      ...pageErrors.slice(0, 3).map((e) => `  ${e.split('\n')[0]}`),
      '',
      'body html head:',
      `  ${String(out.pageState?.bodyHtmlHead).slice(0, 300)}`,
    ].join('\n'),
  );
  await browser.disconnect();
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}13-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '13-ww-boot-blockers.json', out);
  console.log(`\nsaved ${path}`);
}
