#!/usr/bin/env node
/**
 * 18 — engine patch probe: can a pure-JS prelude close Obscura's worker gaps
 * and get WhatsApp Web to a QR?
 *
 * Obscura has no real worker isolate. Its `Worker` is a same-thread eval whose
 * scope object omits `importScripts`, `navigator.locks`, `navigator.storage`
 * and `caches` — the exact three things WhatsApp Web's worker touches during
 * boot (results/13-ww-boot-blockers.json). Because that Worker is implemented
 * in JS, the gaps may be fixable without touching Rust, which would make
 * "Obscura as the engine" a bootstrap change instead of an engine fork.
 *
 * `spike/lib/worker-polyfill.js` is injected with evaluateOnNewDocument and
 * replaces `window.Worker` with an emulation that recursively inlines literal
 * `importScripts(...)` calls and provides the missing worker globals.
 *
 * Usage:
 *   node spike/18-worker-polyfill.mjs             # with the prelude
 *   node spike/18-worker-polyfill.mjs --control   # same run, no prelude
 */
import { mkdir, readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import {
  ObscuraServer,
  connectPuppeteer,
  freePort,
  processTreeRss,
  saveResult,
} from './lib/obscura.mjs';
import { installWsBridge } from './lib/ws-bridge.mjs';

process.env.OBSCURA_SCRIPT_DEADLINE_MS ??= '60000';
process.env.OBSCURA_MODULE_BUDGET_MS ??= '15000';

const control = process.argv.includes('--control');
// Shorter default poll keeps diagnostic iterations inside tool time limits.
const BOOT_MS = Number(process.env.SPIKE_BOOT_MS ?? 75_000);
const label = control ? '18-control' : '18-worker-polyfill';
const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const polyfillPath = new URL('./lib/worker-polyfill.js', import.meta.url).pathname;
const polyfillSource = await readFile(polyfillPath, 'utf8');
const wsShimSource = await readFile(new URL('./lib/ws-shim.js', import.meta.url).pathname, 'utf8');
// Obscura's subtle is symmetric-only; WhatsApp's Noise handshake needs X25519.
// noble first (defines __obscuraNoble), then the wrapper, then the worker
// prelude so its crypto instrumentation records the polyfilled calls too.
const nobleSource = await readFile(new URL('./lib/noble-bundle.js', import.meta.url).pathname, 'utf8');
const subtleSource = await readFile(new URL('./lib/subtle-polyfill.js', import.meta.url).pathname, 'utf8');
const waDiagSource = await readFile(new URL('./lib/wa-diag.js', import.meta.url).pathname, 'utf8');

const storageDir = `${resultsDir}storage-${label}`;
const out = {
  script: label,
  control,
  startedAt: new Date().toISOString(),
  console: [],
  requests: [],
  responses: [],
};

const race = (promise, ms, tag) =>
  Promise.race([
    promise.then((v) => ({ ok: true, v })),
    new Promise((r) => setTimeout(() => r({ ok: false, v: `timeout after ${ms}ms (${tag})` }), ms)),
  ]);

const port = await freePort();
const server = new ObscuraServer({ port, storageDir });

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  );

  // The tunnel is installed for every run: without it the page has no socket
  // at all, so "control" would only re-test the stub.
  const bridge = await installWsBridge(page);
  await page.evaluateOnNewDocument(wsShimSource);
  if (!control) {
    await page.evaluateOnNewDocument(waDiagSource);
    await page.evaluateOnNewDocument(nobleSource);
    await page.evaluateOnNewDocument(subtleSource);
    await page.evaluateOnNewDocument(polyfillSource);
  }

  page.on('console', (msg) => {
    if (out.console.length < 600) {
      out.console.push({ type: msg.type(), text: msg.text().slice(0, 400) });
    }
  });
  page.on('pageerror', (err) => {
    (out.pageErrors ??= []).push(String(err.message || err).slice(0, 400));
  });
  page.on('request', (req) => {
    const url = req.url();
    if (out.requests.length < 300) {
      const entry = { url, type: req.resourceType() };
      if (/worker_module|init_script|webworker_v4/.test(url)) entry.headers = req.headers();
      out.requests.push(entry);
    }
  });
  page.on('response', (res) => {
    if (out.responses.length < 300) out.responses.push({ url: res.url(), status: res.status() });
  });
  page.on('requestfailed', (req) => {
    if ((out.requestFailed ??= []).length < 40) {
      out.requestFailed.push({
        url: req.url().slice(0, 200),
        error: req.failure()?.errorText ?? 'unknown',
      });
    }
  });

  const t0 = Date.now();
  const nav = await race(
    page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 120_000 }),
    130_000,
    'goto',
  );
  out.gotoMs = nav.ok ? Date.now() - t0 : null;
  if (!nav.ok) throw new Error(`navigation failed: ${nav.v}`);

  // Poll until QR or authenticated; stop early on a QR so the run is fast.
  const tBoot = Date.now();
  let snap = {};
  const boot = await race(
    (async () => {
      const deadline = Date.now() + BOOT_MS;
      while (Date.now() < deadline) {
        snap = await page.evaluate(() => {
          const qr =
            document.querySelector('div[data-testid="qrcode"]') ??
            document.querySelector('canvas[aria-label]') ??
            document.querySelector('canvas');
          return {
            debugVersion: window.Debug?.VERSION ?? null,
            hasRequire: typeof window.require === 'function',
            hasQr: Boolean(qr),
            qrLabel: qr?.getAttribute?.('aria-label') ?? null,
            hasPaneSide: Boolean(document.querySelector('#pane-side')),
            canvasCount: document.querySelectorAll('canvas').length,
            imgCount: document.querySelectorAll('img').length,
            dataRef: document.querySelector('[data-ref]')?.getAttribute('data-ref') ?? null,
            scanText: (document.body?.innerText ?? '').includes('Scan to log in'),
            wsReceived: window.__obscuraWsShim?.received ?? 0,
            wsSent: window.__obscuraWsShim?.sent ?? 0,
            wsReady: (window.__obscuraWsShim?.created ?? []).length,
            title: document.title,
            polyfill: window.__obscuraWorkerPolyfill
              ? {
                  created: window.__obscuraWorkerPolyfill.created.length,
                  inlined: window.__obscuraWorkerPolyfill.inlined.length,
                  misses: window.__obscuraWorkerPolyfill.misses.length,
                  errors: window.__obscuraWorkerPolyfill.errors.length,
                  htmlSources: window.__obscuraWorkerPolyfill.htmlSources.length,
                }
              : null,
            bodyText: document.body?.innerText?.slice(0, 300) ?? '',
          };
        });
        out.bootSnapshot = snap;
        if (snap.hasQr || snap.hasPaneSide) return snap;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return snap;
    })(),
    130_000,
    'boot',
  );
  out.bootMs = Date.now() - tBoot;
  out.timedOut = !boot.ok;

  out.state = snap.hasPaneSide ? 'authenticated-looking' : snap.hasQr ? 'qr-shown' : 'not-ready';
  out.readyish = out.state !== 'not-ready';

  out.workerSources = await page
    .evaluate(() => (window.__obscuraWorkerPolyfill?.sources ?? []).map((s) => s))
    .catch(() => []);

  out.workerDiag = await page
    .evaluate(() => {
      const d = window.__obscuraWorkerPolyfill;
      if (!d) return null;
      return {
        version: d.version,
        created: d.created.slice(0, 20),
        inlined: d.inlined.slice(0, 40),
        misses: d.misses.slice(0, 40),
        errors: d.errors.slice(0, 40),
        htmlSources: d.htmlSources.slice(0, 20),
        statuses: (d.statuses || []).slice(0, 40),
        rejections: (d.rejections || []).slice(0, 10),
        hrp: d.hrp || null,
        defines: (d.defines || []).slice(0, 300),
        handlerDeps: d.handlerDeps || null,
        handlerFactory: d.handlerFactory || null,
        posts: (d.posts || []).slice(0, 60),
        messages: (d.messages || []).slice(0, 60),
        importCalls: (d.importCalls || []).slice(0, 20),
        sourceSizes: (d.sourceSizes || []).slice(0, 20),
      };
    })
    .catch((e) => ({ probeError: String(e.message || e) }));

  out.waDiag = await page.evaluate(() => window.__waDiag ?? null).catch(() => null);

  // The worker script is fetched by the prelude itself, so a failure here is
  // the engine's HTTP stack, not WhatsApp's boot logic. Re-fetch it under
  // several credentials modes to separate "server said no" from "engine sent a
  // malformed request".
  const firstWorkerUrl = out.workerDiag?.created?.[0];
  if (firstWorkerUrl) {
    out.assetProbe = await page
      .evaluate(async (u) => {
        const res = {};
        const attempt = async (label, target, opts) => {
          try {
            const r = await fetch(target, opts);
            const text = await r.text();
            res[label] = {
              status: r.status,
              type: r.headers.get('content-type'),
              len: text.length,
              head: text.slice(0, 160),
            };
          } catch (e) {
            res[label] = { error: String(e.message || e) };
          }
        };
        await attempt('include', u, { credentials: 'include' });
        await attempt('same-origin', u, { credentials: 'same-origin' });
        await attempt('omit', u, { credentials: 'omit' });
        await new Promise((resolve) => {
          try {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', u, true);
            xhr.onload = () => {
              res.xhr = {
                status: xhr.status,
                type: xhr.getResponseHeader('content-type'),
                len: (xhr.responseText || '').length,
                head: (xhr.responseText || '').slice(0, 160),
              };
              resolve();
            };
            xhr.onerror = () => {
              res.xhr = { error: 'xhr error' };
              resolve();
            };
            xhr.send();
          } catch (e) {
            res.xhr = { error: String(e.message || e) };
            resolve();
          }
        });
        return res;
      }, firstWorkerUrl)
      .catch((e) => ({ probeError: String(e.message || e) }));
  }

  out.instrument = await page
    .evaluate(() => {
      const d = window.__obscuraWorkerPolyfill;
      if (!d) return null;
      const cryptoCalls = d.crypto || [];
      const cryptoSummary = {};
      for (const c of cryptoCalls) {
        const key = `${c.op} ${c.alg}${c.curve ? '/' + c.curve : ''} -> ${
          c.err ? 'ERR: ' + c.err : c.state || 'ok'
        }`;
        cryptoSummary[key] = (cryptoSummary[key] || 0) + 1;
      }
      const msgCounts = {};
      for (const m of d.messages || []) {
        const k = `${m.dir} ${m.type}`;
        msgCounts[k] = (msgCounts[k] || 0) + 1;
      }
      return {
        crypto: Object.entries(cryptoSummary).map(([k, n]) => ({ k, n })),
        ws: d.ws || [],
        messages: Object.entries(msgCounts).map(([k, n]) => ({ k, n })),
      };
    })
    .catch((e) => ({ probeError: String(e.message || e) }));

  out.wsShim = await page
    .evaluate(() => {
      const d = window.__obscuraWsShim;
      if (!d) return null;
      return {
        created: d.created,
        sent: d.sent,
        sentBytes: d.sentBytes,
        received: d.received,
        receivedBytes: d.receivedBytes,
        maxFrame: d.maxFrame,
        errors: d.errors.slice(0, 20),
        closes: (d.closes || []).slice(0, 30),
        frames: (d.frames || []).slice(0, 40),
        attempts: (d.attempts || []).slice(0, 30),
        dropped: (d.dropped || []).slice(0, 20),
      };
    })
    .catch((e) => ({ probeError: String(e.message || e) }));

  out.rssMb = (await processTreeRss(server.child.pid)).totalMb;

  await page
    .screenshot({ path: `${resultsDir}${label}.png`, fullPage: false })
    .catch((e) => (out.screenshotError = String(e.message || e)));

  out.consoleSummary = summarize(out.console);
  out.pageErrors = (out.pageErrors ?? []).slice(0, 20);

  console.log(
    [
      `run: ${label}${control ? ' (control, no prelude)' : ''}`,
      `state: ${out.state}${out.timedOut ? ' (poll timed out)' : ''}`,
      `navigation: ${out.gotoMs} ms, boot: ${out.bootMs} ms`,
      `Debug.VERSION: ${snap.debugVersion ?? 'missing'}`,
      `QR: ${snap.hasQr ? 'PRESENT' : 'missing'}, #pane-side: ${snap.hasPaneSide ? 'present' : 'missing'}`,
      out.workerDiag
        ? `workers: ${out.workerDiag.created?.length ?? 0} created, ${out.workerDiag.inlined?.length ?? 0} inlined, ${out.workerDiag.misses?.length ?? 0} misses, ${out.workerDiag.errors?.length ?? 0} errors`
        : 'workers: polyfill not installed',
      out.assetProbe
        ? `asset probe: ${Object.entries(out.assetProbe)
            .map(([k, v]) => `${k}=${v.status ?? v.error}`)
            .join(' ')}`
        : 'asset probe: not run',
      `crypto: ${(out.instrument?.crypto || [])
        .map((c) => `${c.n}x ${c.k}`)
        .join(' | ')
        .slice(0, 400)}`,
      `ws: ${(out.instrument?.ws || []).map((w) => `${w.state} ${w.url.slice(0, 40)}`).join(' | ')}`,
      `messages: ${(out.instrument?.messages || [])
        .map((m) => `${m.n}x ${m.k}`)
        .join(' | ')
        .slice(0, 400)}`,
      `ws: sent=${out.wsShim?.sent ?? 0} recv=${out.wsShim?.received ?? 0} bytesIn=${out.wsShim?.receivedBytes ?? 0} maxFrame=${out.wsShim?.maxFrame ?? 0} errors=${JSON.stringify(
        out.wsShim?.errors ?? [],
      )}`,
      `RSS: ${out.rssMb} MB`,
    ].join('\n'),
  );

  await bridge.dispose();
  await browser.disconnect();
} catch (err) {
  out.ok = false;
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}${label}.log`);
  await server.stop();
  const path = await saveResult(resultsDir, `${label}.json`, out);
  console.log(`\nsaved ${path}`);
}

function summarize(entries) {
  const counts = new Map();
  for (const e of entries) {
    const key = `${e.type}: ${e.text}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([text, n]) => ({ n, text }));
}
