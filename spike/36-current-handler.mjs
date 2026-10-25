#!/usr/bin/env node
/**
 * 36 — load the current build's handler chunk into the production bridge.
 *
 * The current document never bootloads `WAWebSetFrontendHandlerApi`, but the
 * exact resource is known (rsrc hash 0q3yXR2). This probe injects that chunk
 * after navigation, runs the production bridge installer, and reports whether
 * the full frontend handler map registers.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ObscuraServer, freePort } from './lib/obscura.mjs';
import { connectCdp } from './lib/cdp-client.mjs';
import { installWsBridgeRaw, WS_ADAPTER } from './lib/ws-bridge-raw.mjs';

process.env.OBSCURA_SCRIPT_DEADLINE_MS ??= '60000';
process.env.OBSCURA_MODULE_BUDGET_MS ??= '15000';

const CHUNK_FILE =
  process.env.HANDLER_CHUNK_FILE ?? '/tmp/wa-all/0q3yXR2.js';
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS ?? 30_000);
const resultsDir = new URL('../results/', import.meta.url).pathname;
const storageDir = `${resultsDir}storage-36`;
await mkdir(resultsDir, { recursive: true });

const workerSource = await readFile(new URL('./lib/worker-polyfill.js', import.meta.url), 'utf8');
const wsShimSource = await readFile(new URL('./lib/ws-shim.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('./lib/wa-bridge.js', import.meta.url), 'utf8');
const chunkSource = await readFile(CHUNK_FILE, 'utf8');

const out = { script: '36-current-handler', startedAt: new Date().toISOString() };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir });
let cdp;
let sessionId;

const stateExpr = `(() => {
  const qr = document.querySelector('div[data-testid="qrcode"]') || document.querySelector('canvas');
  const r = qr ? qr.getBoundingClientRect() : null;
  const text = document.body?.innerText || '';
  return {
    hasQr: !!(r && r.width > 10 && r.height > 10),
    authenticated: !r && !text.includes('Scan to log in') && (!!document.querySelector('#pane-side') || text.includes('Loading your chats')),
    ready: !!document.querySelector('#pane-side'),
    bridgeStatus: window.__waBridgeStatus || null,
    bridgeErrors: (window.__waBridgeErrors || []).slice(0, 6),
    handlerDefined: (() => {
      try {
        return typeof window.require('WAWebSetFrontendHandlerApi') === 'object';
      } catch (e) {
        return false;
      }
    })(),
    namespaces: window.__waBridge && window.__waBridge.getHandledNamespaces
      ? window.__waBridge.getHandledNamespaces()
      : null,
    text: text.slice(0, 240),
  };
})()`;

try {
  await server.start();
  cdp = await connectCdp(port);
  const page = await cdp.createPage();
  sessionId = page.sessionId;
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 900, height: 700, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );

  const bridge = await installWsBridgeRaw(cdp, sessionId);
  await cdp.addScript(sessionId, WS_ADAPTER);
  await cdp.addScript(sessionId, wsShimSource);
  await cdp.addScript(sessionId, workerSource);
  await cdp.addScript(sessionId, bridgeSource);

  cdp.on('Runtime.exceptionThrown', (params) => {
    if ((out.exceptions ||= []).length < 20) {
      out.exceptions.push(
        (params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || '').slice(0, 300),
      );
    }
  });

  await cdp.navigate(sessionId, 'https://web.whatsapp.com/');

  const deadline = Date.now() + 45_000;
  let state = {};
  while (Date.now() < deadline) {
    state = await cdp.evaluate(sessionId, stateExpr).catch(() => ({}));
    if (state.hasQr || state.authenticated) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  out.before = state;

  out.injected = await cdp
    .evaluate(
      sessionId,
      `(() => {
        const script = document.createElement('script');
        script.textContent = ${JSON.stringify(chunkSource)};
        document.head.appendChild(script);
        return {
          defined: (() => {
            try {
              return typeof window.require('WAWebSetFrontendHandlerApi') === 'object';
            } catch (e) {
              return false;
            }
          })(),
          deviceInfo: (() => {
            try {
              return typeof window.require('WAWebDeviceInfoBridgeApi') === 'object';
            } catch (e) {
              return false;
            }
          })(),
        };
      })()`,
    )
    .catch((e) => ({ error: String(e.message || e) }));

  await new Promise((resolve) => setTimeout(resolve, 1500));

  out.full = await cdp
    .evaluate(
      sessionId,
      `(() => {
        const r = { install: 'missing' };
        try {
          r.install = window.__waInstallFullBridge ? window.__waInstallFullBridge() : 'missing';
        } catch (e) {
          r.error = String(e.message || e);
        }
        r.status = window.__waBridgeStatus || null;
        r.errors = (window.__waBridgeErrors || []).slice(0, 8);
        return r;
      })()`,
    )
    .catch((e) => ({ error: String(e.message || e) }));

  await new Promise((resolve) => setTimeout(resolve, 1000));
  out.after = await cdp.evaluate(sessionId, stateExpr).catch(() => ({}));
  out.pss = await (async () => {
    try {
      const rollup = await readFile(`/proc/${server.child.pid}/smaps_rollup`, 'utf8');
      const pss = rollup.match(/^Pss:\s+(\d+) kB/m);
      return pss ? Math.round(Number(pss[1]) / 1024) : null;
    } catch {
      return null;
    }
  })();

  console.log(
    [
      `before: ${JSON.stringify(out.before)}`,
      `injected: ${JSON.stringify(out.injected)}`,
      `full: ${JSON.stringify(out.full)}`,
      `after: ${JSON.stringify(out.after)}`,
      `pss: ${out.pss} MB`,
    ].join('\n'),
  );

  const png = await cdp.screenshot(sessionId).catch(() => null);
  if (png) await writeFile('/tmp/ObscuraWA-36.png', png);

  if (KEEPALIVE_MS > 0) {
    const until = Date.now() + KEEPALIVE_MS;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      out.last = await cdp.evaluate(sessionId, stateExpr).catch(() => ({}));
    }
  }
} catch (e) {
  out.error = String(e.stack || e);
  console.error('FAILED:', out.error);
  process.exitCode = 1;
} finally {
  if (cdp) {
    await cdp.collectGarbage(sessionId).catch(() => {});
    cdp.close();
  }
  await server.stop();
  await writeFile(`${resultsDir}36-current-handler.json`, JSON.stringify(out, null, 2)).catch(
    () => {},
  );
  console.log(`saved ${resultsDir}36-current-handler.json`);
}
