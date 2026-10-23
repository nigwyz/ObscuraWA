#!/usr/bin/env node
/**
 * G1 — does WhatsApp Web actually boot inside Obscura, and does it reach a
 * QR / authenticated state?
 *
 * No phone needed: it stops at the QR.
 */
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import {
  ObscuraServer,
  connectPuppeteer,
  freePort,
  processTreeRss,
  saveResult,
} from './lib/obscura.mjs';

// WhatsApp Web is a heavy SPA; Obscura caps script execution at 30s by default.
process.env.OBSCURA_SCRIPT_DEADLINE_MS ??= '60000';
process.env.OBSCURA_MODULE_BUDGET_MS ??= '15000';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const storageDir = process.env.SPIKE_STORAGE_DIR ?? `${resultsDir}storage-01`;
const out = { script: '01-boot', startedAt: new Date().toISOString(), console: [] };
const race = (promise, ms, label) =>
  Promise.race([
    promise.then((v) => ({ ok: true, v })),
    new Promise((r) =>
      setTimeout(() => r({ ok: false, v: `timeout after ${ms}ms (${label})` }), ms),
    ),
  ]);

const port = await freePort();
const server = new ObscuraServer({ port, storageDir });

try {
  const t0 = Date.now();
  await server.start();
  out.serverStartMs = Date.now() - t0;

  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();

  page.on('console', (msg) => {
    if (out.console.length < 400) {
      out.console.push({ type: msg.type(), text: msg.text().slice(0, 300) });
    }
  });
  page.on('pageerror', (err) => {
    (out.pageErrors ??= []).push(String(err.message || err).slice(0, 400));
  });
  page.on('requestfailed', (req) => {
    (out.requestFailed ??= []).push({
      url: req.url().slice(0, 200),
      error: req.failure()?.errorText ?? 'unknown',
    });
  });

  const tNav = Date.now();
  const nav = await race(
    page.goto('https://web.whatsapp.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    }),
    130_000,
    'goto web.whatsapp.com',
  );
  out.gotoMs = nav.ok ? Date.now() - tNav : null;
  if (!nav.ok) throw new Error(`navigation failed: ${nav.v}`);

  // Wait for the app to reach either the QR or an authenticated state.
  const tBoot = Date.now();
  let state = 'unknown';
  const bootPoll = await race(
    (async () => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const snap = await page.evaluate(() => {
          const qr =
            document.querySelector('canvas[aria-label]') ??
            document.querySelector('div[data-testid="qrcode"]') ??
            document.querySelector('canvas');
          const paneSide = Boolean(document.querySelector('#pane-side'));
          const loginButton = Boolean(
            document.querySelector('[data-testid="intro-md-beta-logo-dark"], #fallback_block'),
          );
          return {
            debugVersion:
              (typeof window.Debug !== 'undefined' && window.Debug?.VERSION) || null,
            hasRequire: typeof window.require === 'function',
            hasWebpackChunk: typeof window.webpackChunkbuild === 'object' ||
              typeof window.webpackChunkbuild === 'function' ||
              typeof window.webpackChunk === 'function' ||
              typeof window.webpackChunk === 'object',
            hasWWebJS: typeof window.WWebJS !== 'undefined',
            hasQr: Boolean(qr),
            qrLabel: qr?.getAttribute?.('aria-label') ?? null,
            hasPaneSide: paneSide,
            loginButton,
            title: document.title,
            bodyText: document.body?.innerText?.slice(0, 200) ?? '',
          };
        });
        if (snap.debugVersion && snap.hasRequire && (snap.hasQr || snap.hasPaneSide)) {
          out.bootSnapshot = snap;
          return snap;
        }
        out.bootSnapshot = snap;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return out.bootSnapshot;
    })(),
    130_000,
    'boot poll',
  );
  out.bootMs = bootPoll.ok ? Date.now() - tBoot : null;
  const snap = out.bootSnapshot ?? {};

  state = snap.hasPaneSide
    ? 'authenticated-looking'
    : snap.hasQr
      ? 'qr-shown'
      : 'not-ready';
  out.state = state;
  out.readyish = state !== 'not-ready';

  await page
    .screenshot({ path: `${resultsDir}01-whatsapp-boot.png`, fullPage: false })
    .catch((e) => (out.screenshotError = String(e.message || e)));

  out.rssMb = (await processTreeRss(server.child.pid)).totalMb;
  out.consoleSummary = summarize(out.console);
  out.pageErrorCount = (out.pageErrors ?? []).length;
  out.pageErrors = (out.pageErrors ?? []).slice(0, 20);
  out.requestFailed = (out.requestFailed ?? []).slice(0, 20);

  console.log(
    [
      `state: ${state}`,
      `navigation: ${out.gotoMs} ms, boot: ${out.bootMs} ms`,
      `Debug.VERSION: ${snap.debugVersion ?? 'missing'}`,
      `window.require: ${snap.hasRequire ? 'present' : 'MISSING'}`,
      `webpackChunk: ${snap.hasWebpackChunk ? 'present' : 'missing'}`,
      `QR canvas: ${snap.hasQr ? 'present' : 'missing'} (label: ${snap.qrLabel ?? '-'})`,
      `#pane-side: ${snap.hasPaneSide ? 'present' : 'missing'}`,
      `page errors: ${out.pageErrorCount}, failed requests: ${(out.requestFailed ?? []).length}`,
      `RSS: ${out.rssMb} MB`,
    ].join('\n'),
  );
  await browser.disconnect();
} catch (err) {
  out.ok = false;
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}01-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '01-boot.json', out);
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
    .slice(0, 25)
    .map(([text, n]) => ({ n, text }));
}
