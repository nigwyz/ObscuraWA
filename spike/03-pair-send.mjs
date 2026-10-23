#!/usr/bin/env node
/**
 * G3 — pair a real WhatsApp account and exchange a message on Obscura.
 *
 * This is the adapter under test: whatsapp-web.js pointed at an external
 * Obscura endpoint. It doubles as the re-evaluation entry point: when upstream
 * lands persistent IndexedDB (#1158) and worker importScripts (#827), re-run
 * this with a phone to redo G3/G4/G5.
 *
 * Human step: scanning the printed QR is required for a full run. Set
 * SPIKE_PAIR=1 to pair, and optionally SPIKE_SEND_TO=<number@s.whatsapp.net>
 * to exercise an outbound message. Without SPIKE_PAIR it runs for
 * SPIKE_WAIT_MS (default 120s) and reports how far the adapter got.
 *
 * Session material lives in sessions/ (gitignored). The QR payload is printed
 * to the terminal only and never written to disk or results/.
 */
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import QRCode from 'qrcode-terminal';

process.env.OBSCURA_SCRIPT_DEADLINE_MS ??= '60000';
process.env.OBSCURA_MODULE_BUDGET_MS ??= '15000';

const resultsDir = new URL('../results/', import.meta.url).pathname;
const sessionDir = new URL('../sessions/obscura-g3/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });
await mkdir(sessionDir, { recursive: true });

const out = { script: '03-pair-send', pairMode: process.env.SPIKE_PAIR === '1' };
const waitMs = Number(process.env.SPIKE_WAIT_MS ?? (out.pairMode ? 600_000 : 120_000));

const { default: WhatsApp } = await import('whatsapp-web.js');
const { Client, NoAuth } = WhatsApp;
const { ObscuraServer, connectPuppeteer, freePort } = await import('./lib/obscura.mjs');

const port = await freePort();
const server = new ObscuraServer({ port, storageDir: sessionDir });

try {
  await server.start();

  const client = new Client({
    authStrategy: new NoAuth(),
    puppeteer: { browserWSEndpoint: server.wsEndpoint },
    // Live WhatsApp Web, no cached snapshot: this is a test of the adapter
    // against the current app, exactly as a deployment would run it.
    webVersionCache: { type: 'none' },
  });

  const t0 = Date.now();
  const events = [];
  const log = (name, detail) => {
    events.push({ at: Date.now() - t0, name, detail });
    console.log(`[+${String(Date.now() - t0).padStart(6)} ms] ${name}${detail ? ` — ${detail}` : ''}`);
  };

  let qrShown = false;
  client.on('qr', (qr) => {
    if (qrShown) return;
    qrShown = true;
    out.qrAtMs = Date.now() - t0;
    out.qrLength = qr.length;
    log('qr');
    QRCode.generate(qr, { small: true });
  });
  client.on('loading_screen', (percent, msg) => {
    if (percent % 25 === 0) log('loading_screen', `${percent}% ${msg}`);
  });
  client.on('authenticated', () => log('authenticated'));
  client.on('auth_failure', (m) => {
    out.authFailure = String(m);
    log('auth_failure', m);
  });
  client.on('ready', async () => {
    out.readyAtMs = Date.now() - t0;
    log('ready');
    const to = process.env.SPIKE_SEND_TO;
    if (!to) return;
    try {
      const sent = await client.sendMessage(to, { text: 'ObscuraWA M0 spike test' });
      out.send = { to, id: sent.id?._serialized, ts: Date.now() - t0 };
      const ack = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('ack-timeout'), 30_000);
        client.once('message_ack', (msg, ack2) => {
          clearTimeout(timer);
          resolve(`ack-${ack2}`);
        });
      });
      out.send.ack = ack;
      log('message ack', ack);
    } catch (err) {
      out.send = { error: String(err.message || err) };
      log('send failed', out.send.error);
    }
  });
  client.on('disconnected', (reason) => {
    out.disconnected = String(reason);
    log('disconnected', reason);
  });

  const initStart = Date.now();

  // Optional second-connection watcher (off by default: a second connection
  // changes context lifetimes and confounds the adapter test). Enable with
  // SPIKE_WATCH=1 when you want to watch the page while initialize() runs.
  let watcher;
  if (process.env.SPIKE_WATCH === '1') {
    try {
    const puppeteer = (await import('puppeteer-core')).default;
    const watchConn = await connectPuppeteer(port, puppeteer);
    const snapshots = [];
    // The adapter creates its own page; watch whichever page is actually on
    // web.whatsapp.com (a fresh connection may see none for a moment).
    const targetPage = async () => {
      const pages = await watchConn.browser.pages();
      return (
        pages.find((pg) => pg.url().includes('whatsapp')) ??
        pages[0] ??
        (await watchConn.browser.newPage())
      );
    };
    const tick = async () => {
      try {
        const page = await targetPage();
        snapshots.push({
          at: Date.now() - initStart,
          url: page.url().slice(0, 60),
          state: await page.evaluate(() => {
            let socketState = null;
            let socketError = null;
            try {
              socketState = window.require('WAWebSocketModel').Socket.state;
            } catch (e) {
              socketError = String(e.message || e);
            }
            return {
              debugVersion: window.Debug?.VERSION ?? null,
              socketState,
              socketError,
              hasQrCanvas: Boolean(document.querySelector('canvas')),
              hasPaneSide: Boolean(document.querySelector('#pane-side')),
              bodyHtmlLength: document.body?.innerHTML?.length ?? -1,
              readyState: document.readyState,
            };
          }),
        });
      } catch (err) {
        snapshots.push({ at: Date.now() - initStart, error: String(err.message || err) });
      }
    };
    watcher = setInterval(tick, 2000);
    await tick();
    out.snapshotsDuringInit = snapshots;
    setTimeout(() => clearInterval(watcher), waitMs + 5_000);
    out._watchConn = watchConn;
  } catch (err) {
    out.watcherError = String(err.message || err);
  }
  }

  let init = 'initialized';
  try {
    const raced = await Promise.race([
      client.initialize().then(() => 'initialized'),
      sleep(waitMs).then(() => 'timeout'),
    ]);
    init = raced;
  } catch (err) {
    init = 'error';
    out.initializeError = String(err.message || err);
    out.initializeErrorLine = String(err.stack || '')
      .split('\n')
      .find((l) => l.includes('whatsapp-web.js')) ?? null;
    log('initialize threw', out.initializeError);
  }
  out.initializeResult = init;
  out.initializeMs = Date.now() - initStart;
  if (watcher) clearInterval(watcher);
  const good = (out.snapshotsDuringInit ?? []).filter(
    (s) => s.state && s.state.bodyHtmlLength > 0,
  );
  out.pageStateDuringInit = good.at(-1) ?? (out.snapshotsDuringInit ?? [])[0] ?? null;

  // Whatever happened, record the page state after the failure too.
  try {
    const puppeteer = (await import('puppeteer-core')).default;
    const diag = out._watchConn ?? (await connectPuppeteer(port, puppeteer));
    const pages = await diag.browser.pages();
    out.pagesAfter = pages.map((pg) => pg.url().slice(0, 80));
    const p =
      pages.find((pg) => pg.url().includes('whatsapp')) ??
      pages[0] ??
      (await diag.browser.newPage());
    out.pageStateAfterUrl = p.url().slice(0, 80);
    out.pageStateAfter = await p.evaluate(() => {
      let socketState = null;
      let socketError = null;
      try {
        socketState = window.require('WAWebSocketModel').Socket.state;
      } catch (e) {
        socketError = String(e.message || e);
      }
      return {
        debugVersion: window.Debug?.VERSION ?? null,
        socketState,
        socketError,
        hasQrCanvas: Boolean(document.querySelector('canvas')),
        hasPaneSide: Boolean(document.querySelector('#pane-side')),
        bodyHtmlLength: document.body?.innerHTML?.length ?? -1,
        readyState: document.readyState,
      };
    });
    await diag.browser.disconnect().catch(() => {});
  } catch (err) {
    out.pageStateError = String(err.message || err);
  }

  if (init === 'initialized' && !out.pairMode) {
    // Adapter came up: stay alive long enough to observe QR/loading progress.
    await sleep(Math.max(0, waitMs - out.initializeMs));
  }

  out.reachedQr = Boolean(qrShown);
  out.reachedReady = Boolean(out.readyAtMs);
  out.events = events;
  out.verdict = out.reachedReady
    ? 'G3 exercised (pair + send)'
    : out.reachedQr
      ? 'adapter up, QR rendered — pair step required'
      : init === 'error'
        ? 'adapter initialize() threw — G3 blocked'
        : 'adapter did not reach a QR — blocked by G1 boot failure';
  console.log(`\nverdict: ${out.verdict}`);
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  try {
    await client?.destroy?.();
  } catch {
    /* already torn down */
  }
  await server.stop();

  // Append this attempt to a durable run history: one run is an anecdote, the
  // distribution is the evidence. Each entry is summary-only (no QR, no
  // session material).
  const entry = {
    at: new Date().toISOString(),
    initializeResult: out.initializeResult,
    initializeMs: out.initializeMs,
    initializeError: out.initializeError ?? null,
    errorSite: out.initializeErrorLine
      ? (out.initializeErrorLine.match(/Client\.\w+/) ?? [out.initializeErrorLine])[0]
      : null,
    reachedQr: Boolean(out.reachedQr),
    reachedReady: Boolean(out.reachedReady),
    verdict: out.verdict,
  };
  const historyPath = `${resultsDir}03-pair-send-history.json`;
  const { readFile, writeFile } = await import('node:fs/promises');
  let history = [];
  try {
    history = JSON.parse(await readFile(historyPath, 'utf8'));
  } catch {
    history = [];
  }
  history.push(entry);
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);

  const path = `${resultsDir}03-pair-send.json`;
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`);
  const summary = history.reduce((acc, h) => {
    const key = h.initializeError ? `${h.errorSite}: ${h.initializeError.slice(0, 70)}` : h.initializeResult;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `runs=${history.length} reachedQr=${history.filter((h) => h.reachedQr).length}\n` +
      `signatures: ${JSON.stringify(summary, null, 1)}`,
  );
  console.log(`saved ${path}`);
  console.log(`saved ${historyPath}`);
  setTimeout(() => process.exit(0), 1500);
}
