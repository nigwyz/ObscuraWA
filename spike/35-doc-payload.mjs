#!/usr/bin/env node
/**
 * 35 — capture the WhatsApp server document and bootloader payload.
 *
 * The current build reaches a QR but never loads the deferred
 * WAWebSetFrontendHandlerApi chunk. `HasteSupportData` exposes only `handle`,
 * so the Bootloader has no resource map. This probe answers whether the map is
 * missing from the server document itself or lost during boot.
 *
 * Read-only. The document is saved to /tmp, never the repository.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ObscuraServer, freePort } from './lib/obscura.mjs';
import { connectCdp } from './lib/cdp-client.mjs';
import { installWsBridgeRaw, WS_ADAPTER } from './lib/ws-bridge-raw.mjs';

process.env.OBSCURA_SCRIPT_DEADLINE_MS ??= '60000';
process.env.OBSCURA_MODULE_BUDGET_MS ??= '15000';

const resultsDir = new URL('../results/', import.meta.url).pathname;
const storageDir = `${resultsDir}storage-35`;
const DOC_PATH = '/tmp/ObscuraWA-doc.html';
await mkdir(resultsDir, { recursive: true });

const workerSource = await readFile(new URL('./lib/worker-polyfill.js', import.meta.url), 'utf8');
const wsShimSource = await readFile(new URL('./lib/ws-shim.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('./lib/wa-bridge.js', import.meta.url), 'utf8');

const out = { script: '35-doc-payload', startedAt: new Date().toISOString() };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir });
let cdp;

const loaderExpr = `(() => {
  const r = {};
  const seen = new WeakSet();
  const replacer = (key, value) => {
    if (typeof value === 'function') return '[function]';
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    if (typeof value === 'string' && value.length > 300) {
      return value.slice(0, 300) + '…';
    }
    return value;
  };
  const bound = (value) => {
    try {
      return JSON.stringify(value, replacer).slice(0, 5000);
    } catch (e) {
      return '[unserializable: ' + String(e.message || e) + ']';
    }
  };
  const safe = (fn) => {
    try {
      return fn();
    } catch (e) {
      return { error: String(e.message || e) };
    }
  };

  const b = safe(() => window.require('Bootloader'));
  r.bootKeys = b && typeof b === 'object' ? Object.keys(b) : null;
  r.debug = b && b.__debug ? bound(b.__debug) : null;
  r.urlMap = b && b.getURLToHashMap ? bound(b.getURLToHashMap()) : null;
  r.resourceState = b && b.getResourceState ? bound(b.getResourceState()) : null;
  r.components = b && b.getComponentDebugState ? bound(b.getComponentDebugState()) : null;
  r.bootloaded = b && b.getBootloadedComponents ? bound(b.getBootloadedComponents()) : null;
  r.pending = b && b.getBootloadPendingComponents ? bound(b.getBootloadPendingComponents()) : null;
  r.handlePayloadSource = b && b.handlePayload ? String(b.handlePayload).slice(0, 4000) : null;
  r.handlePayloadLength = b && b.handlePayload ? String(b.handlePayload).length : null;
  r.setResourceMapSource = b && b.setResourceMap ? String(b.setResourceMap).slice(0, 2500) : null;

  const env = document.getElementById('envjson');
  r.envjsonLength = env ? (env.textContent || '').length : null;
  r.envjsonHead = env ? (env.textContent || '').slice(0, 400) : null;
  r.spin = window.__spin ?? null;
  r.hs = window.__hs ?? null;
  r.ccg = window.__ccg ?? null;
  r.htmlBytes = document.documentElement.outerHTML.length;
  r.dataSjsCount = document.querySelectorAll('script[type="application/json"][data-sjs]').length;
  r.scripts = Array.from(document.scripts).slice(0, 40).map((s) => ({
    id: s.id || null,
    type: s.type || null,
    dataSjs: s.hasAttribute('data-sjs'),
    src: (s.src || '').slice(0, 180),
    textLength: (s.textContent || '').length,
  }));
  return r;
})()`;

try {
  await server.start();
  cdp = await connectCdp(port);
  const { sessionId } = await cdp.createPage();
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 900, height: 700, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await cdp.send('Network.enable', {}, sessionId);

  let docRequestId = null;
  cdp.on('Network.responseReceived', (params, sid) => {
    if (sid && sid !== sessionId) return;
    const response = params.response || {};
    if (
      params.type === 'Document' &&
      /^https:\/\/web\.whatsapp\.com\/?(?:[?#].*)?$/.test(response.url || '')
    ) {
      docRequestId = params.requestId;
    }
  });

  await installWsBridgeRaw(cdp, sessionId);
  await cdp.addScript(sessionId, WS_ADAPTER);
  await cdp.addScript(sessionId, wsShimSource);
  await cdp.addScript(sessionId, workerSource);
  await cdp.addScript(sessionId, bridgeSource);

  await cdp.navigate(sessionId, 'https://web.whatsapp.com/');

  const deadline = Date.now() + 30_000;
  let body = null;
  while (Date.now() < deadline && !body) {
    if (docRequestId) {
      body = await cdp
        .send('Network.getResponseBody', { requestId: docRequestId }, sessionId)
        .then((r) => (r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body))
        .catch(() => null);
    }
    if (!body) await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (body) {
    await writeFile(DOC_PATH, body);
    out.docPath = DOC_PATH;
    out.docBytes = body.length;
    out.needles = {};
    for (const needle of [
      'envjson',
      'HasteSupportData',
      'WAWebSetFrontendHandlerApi',
      'setResourceMap',
      'resourceMap',
      '__spin',
      'bootloader',
      'rsrc.php',
    ]) {
      out.needles[needle] = body.includes(needle);
    }
    const idx = body.indexOf('envjson');
    out.envjsonContext = idx >= 0 ? body.slice(Math.max(0, idx - 300), idx + 1500) : null;

    // Offline search for the deferred module's URL. A match here means the map
    // exists in the document and the page lost it; no match means the server
    // served a document without the map.
    const moduleUrls = Array.from(
      body.matchAll(/https?:\/\/[^"'\s]+/g),
      (m) => m[0],
    ).filter((u) => /rsrc\\.php|static_resources/.test(u));
    out.moduleUrlCount = moduleUrls.length;
    out.moduleUrlSample = moduleUrls.slice(0, 12);
  }

  out.loader = await cdp.evaluate(sessionId, loaderExpr).catch((e) => ({
    error: String(e.message || e),
  }));
  out.state = await cdp
    .evaluate(
      sessionId,
      `(() => ({
        hasQr: !!document.querySelector('div[data-testid="qrcode"]'),
        text: (document.body?.innerText || '').slice(0, 120),
      }))()`,
    )
    .catch(() => null);

  if (process.env.SPIKE_LOADER_TEST === '1') {
    out.setMapTest = await cdp
      .evaluate(
        sessionId,
        `(() => {
          const b = window.require('Bootloader');
          const before = Object.keys((b.getURLToHashMap && b.getURLToHashMap()) || {}).length;
          let error = null;
          try {
            b.setResourceMap(
              { TESTRES: { type: 'js', src: 'data:text/javascript,window.__testres=1' } },
              null,
              null,
              null,
            );
          } catch (e) {
            error = String(e.message || e);
          }
          const after = (b.getURLToHashMap && b.getURLToHashMap()) || {};
          return {
            before,
            error,
            afterKeys: Object.keys(after).length,
            test: after.TESTRES || null,
            debugResources: Object.keys((b.__debug && b.__debug.resources) || {}).length,
          };
        })()`,
      )
      .catch((e) => ({ error: String(e.message || e) }));
  }

  if (process.env.SPIKE_REPLAY === '1') {
    out.replay = await cdp
      .evaluate(
        sessionId,
        `(async () => {
          const result = { scripts: 0, payloads: 0, errors: [] };
          let b;
          try {
            b = window.require('Bootloader');
          } catch (e) {
            return { error: String(e.message || e) };
          }
          const scripts = document.querySelectorAll('script[type="application/json"][data-sjs]');
          result.scripts = scripts.length;
          for (const script of scripts) {
            let parsed;
            try {
              parsed = JSON.parse(script.textContent || '{}');
            } catch (e) {
              result.errors.push('parse: ' + String(e.message || e));
              continue;
            }
            const req = parsed.require && parsed.require[0];
            if (!req || req[0] !== 'Bootloader' || !req[3] || !req[3][0]) continue;
            result.payloads++;
            try {
              const pending = b.handlePayload(req[3][0]);
              if (pending && typeof pending.then === 'function') await pending;
            } catch (e) {
              result.errors.push('handle ' + result.payloads + ': ' + String(e.message || e));
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const debug = b.__debug || {};
          const urlMap = (b.getURLToHashMap && b.getURLToHashMap()) || {};
          result.after = {
            resources: Object.keys(debug.resources || {}).length,
            componentMap: Object.keys(debug.componentMap || {}).length,
            requestedRsrcIndex: Object.keys(debug.requestedRsrcIndex || {}).length,
            requested: Object.keys(debug.requested || {}).length,
            urlMap: Object.keys(urlMap).length,
          };
          result.handlerUrl = urlMap.WAWebSetFrontendHandlerApi || null;
          result.handlerInCompMap = !!(debug.componentMap && debug.componentMap.WAWebSetFrontendHandlerApi);
          return result;
        })()`,
      )
      .catch((e) => ({ error: String(e.message || e) }));

    out.bootload = await cdp
      .evaluate(
        sessionId,
        `new Promise((resolve) => {
          const done = (value) => resolve(value);
          setTimeout(() => done({ timeout: true }), 20000);
          try {
            const b = window.require('Bootloader');
            b.loadModules(
              ['WAWebSetFrontendHandlerApi'],
              (mods) => {
                const m = mods && mods.WAWebSetFrontendHandlerApi;
                done({ ok: !!m, keys: m ? Object.keys(m).slice(0, 12) : null });
              },
              'obscura-replay',
            );
          } catch (e) {
            done({ error: String(e.message || e) });
          }
        })`,
      )
      .catch((e) => ({ error: String(e.message || e) }));

    out.afterLoad = await cdp
      .evaluate(
        sessionId,
        `(() => ({
          bridge: window.__waBridgeStatus || null,
          full: window.__waInstallFullBridge ? window.__waInstallFullBridge() : 'missing',
          bridgeErrors: (window.__waBridgeErrors || []).slice(0, 4),
          text: (document.body?.innerText || '').slice(0, 200),
        }))()`,
      )
      .catch((e) => ({ error: String(e.message || e) }));
  }

  console.log(
    [
      `doc: ${out.docBytes ?? 'missing'} bytes -> ${out.docPath ?? 'not saved'}`,
      `needles: ${JSON.stringify(out.needles ?? {})}`,
      `envjson: ${out.loader?.envjsonLength ?? 'n/a'} chars`,
      `data-sjs: ${out.loader?.dataSjsCount ?? 'n/a'}`,
      `loader keys: ${(out.loader?.bootKeys ?? []).length}`,
      `debug: ${out.loader?.debug ? out.loader.debug.slice(0, 600) : 'null'}`,
      `handlePayload (${out.loader?.handlePayloadLength ?? 0} chars): ${out.loader?.handlePayloadSource ?? 'null'}`,
      `setResourceMap: ${out.loader?.setResourceMapSource ?? 'null'}`,
      `urlMap: ${out.loader?.urlMap ? out.loader.urlMap.slice(0, 400) : 'null'}`,
      `resourceState: ${out.loader?.resourceState ? out.loader.resourceState.slice(0, 400) : 'null'}`,
      `replay: ${JSON.stringify(out.replay ?? null)}`,
      `setMapTest: ${JSON.stringify(out.setMapTest ?? null)}`,
      `bootload: ${JSON.stringify(out.bootload ?? null)}`,
      `afterLoad: ${JSON.stringify(out.afterLoad ?? null)}`,
      `state: ${JSON.stringify(out.state)}`,
    ].join('\n'),
  );
} catch (e) {
  out.error = String(e.stack || e);
  console.error('FAILED:', out.error);
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  await server.stop();
  await writeFile(`${resultsDir}35-doc-payload.json`, JSON.stringify(out, null, 2)).catch(
    () => {},
  );
  console.log(`saved ${resultsDir}35-doc-payload.json`);
}
