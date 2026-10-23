#!/usr/bin/env node
/**
 * Why does `page.exposeFunction` hang on Obscura while raw CDP bindings work?
 *
 * puppeteer's exposed-function round trip is:
 *   1. host -> page   Runtime.callFunctionOn {awaitPromise:true}   (pending)
 *   2. page  -> host  Runtime.bindingCalled
 *   3. host -> page   Runtime.evaluate  (resolve the page's callback)   <-- step 3
 *   4. host <- page   callFunctionOn response
 *
 * Step 3 can only run if Obscura keeps servicing the connection while a
 * previous command is still awaiting its promise. If commands are serialized
 * per session, step 3 never executes and everything deadlocks.
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

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const port = await freePort();
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-10` });
const out = { script: '10-session-serialization', tests: [] };
const add = (name, ok, detail) => {
  out.tests.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const race = (promise, ms, label) =>
  Promise.race([
    promise.then((v) => ({ ok: true, v })),
    new Promise((r) =>
      setTimeout(() => r({ ok: false, v: `timeout after ${ms}ms on ${label}` }), ms),
    ),
  ]);

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const cdp = await page.createCDPSession();

  const events = [];
  cdp.on('Runtime.bindingCalled', (ev) => events.push({ ...ev, at: Date.now() }));
  cdp.on('Runtime.executionContextCreated', (ev) => events.push({ t: 'ctx', ...ev.context }));
  await cdp.send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 300));
  const contexts = events.filter((e) => e.t === 'ctx');
  const defaultCtx = contexts.find((c) => c.auxData?.type === 'default');
  out.executionContexts = contexts.map((c) => ({ id: c.id, name: c.name }));

  // --- A: does the session keep serving commands while a promise is pending?
  await cdp.send('Runtime.evaluate', {
    expression: 'globalThis.__pending = new Promise(() => {}); globalThis.__resolver = null; globalThis.__resolverState = "pending"; true',
    returnByValue: true,
  });
  const { objectId } = await cdp.send('Runtime.evaluate', { expression: 'window' });

  let callFunctionOnSettled = null;
  const t0 = Date.now();
  callFunctionOnSettled = cdp
    .send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        'async function () { return await globalThis.__pending; }',
      awaitPromise: true,
      returnByValue: true,
    })
    .then((r) => ({ settled: true, at: Date.now() - t0, r }))
    .catch((e) => ({ settled: false, error: String(e.message || e), at: Date.now() - t0 }));

  await new Promise((r) => setTimeout(r, 500));

  const whilePending = await race(
    cdp.send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true }),
    8000,
    'evaluate while callFunctionOn pending',
  );
  add(
    'session serves commands while callFunctionOn awaits a pending promise',
    whilePending.ok && whilePending.v?.result?.value === 2,
    whilePending.ok ? `result=${whilePending.v.result.value}` : String(whilePending.v),
  );

  // --- B: resolve the pending promise from the host; does callFunctionOn return?
  const resolveCall = await race(
    cdp.send('Runtime.evaluate', {
      expression: `globalThis.__resolver = 'resolved'; 'ok'`,
      returnByValue: true,
    }),
    5000,
    'host resolve evaluate',
  );
  add('host can evaluate while a callFunctionOn is still pending', resolveCall.ok,
    resolveCall.ok ? 'ok' : String(resolveCall.v));

  const settled = await race(callFunctionOnSettled, 6000, 'callFunctionOn response');
  add(
    'pending callFunctionOn returns once its promise resolves',
    settled.ok && settled.v?.settled !== false,
    settled.ok ? JSON.stringify(settled.v) : String(settled.v),
  );

  // --- C: same experiment but the pending promise resolves on its own (control)
  await cdp.send('Runtime.evaluate', {
    expression: 'globalThis.__self = new Promise(r => setTimeout(() => r("self"), 300)); true',
    returnByValue: true,
  });
  const selfResolved = await race(
    cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'async function () { return await globalThis.__self; }',
      awaitPromise: true,
      returnByValue: true,
    }),
    8000,
    'self-resolving callFunctionOn',
  );
  add(
    'callFunctionOn awaitPromise works when the page resolves on its own',
    selfResolved.ok && selfResolved.v?.result?.value === 'self',
    selfResolved.ok ? `value=${selfResolved.v.result.value}` : String(selfResolved.v),
  );

  // --- D: replicate the full exposed-function round trip on ONE session.
  const bindingEvents = [];
  cdp.on('Runtime.bindingCalled', (ev) => bindingEvents.push(ev));
  await cdp.send('Runtime.addBinding', { name: 'puppeteer_probe' });
  const initSource = `
    (() => {
      const name = 'probe';
      const prefix = 'puppeteer_';
      if (globalThis[name]) return 'already';
      Object.assign(globalThis, {
        [name](...args) {
          globalThis[prefix + name](JSON.stringify({ type: 'exposedFun', name, seq: 1, args }));
          return new Promise((resolve, reject) => {
            globalThis['__cb_' + name] = { resolve, reject };
          });
        },
      });
      return 'installed';
    })()
  `;
  const install = await cdp.send('Runtime.evaluate', {
    expression: initSource,
    returnByValue: true,
  });
  add('wrapper installs in default context', install.result?.value === 'installed',
    String(install.result?.value) + (install.exceptionDetails ? ` ${install.exceptionDetails.text}` : ''));

  // This is exactly what puppeteer sends: callFunctionOn awaiting the promise
  // returned by the wrapper, which only settles when the host evaluates back.
  const roundTripPromise = cdp
    .send('Runtime.callFunctionOn', {
      executionContextId: defaultCtx?.id,
      functionDeclaration: 'async function () { return await globalThis.probe("ping"); }',
      awaitPromise: true,
      returnByValue: true,
    })
    .then((r) => ({ done: true, value: r.result?.value }))
    .catch((e) => ({ done: false, error: String(e.message || e) }));

  // Wait for the page->host binding event, then resolve exactly like puppeteer
  // Binding.run does.
  const firedAt = Date.now();
  const sawBinding = await race(
    (async () => {
      while (!bindingEvents.length) await new Promise((r) => setTimeout(r, 50));
      return bindingEvents[0];
    })(),
    8000,
    'bindingCalled for exposed wrapper',
  );
  add(
    'page->host Runtime.bindingCalled for the exposed wrapper',
    sawBinding.ok,
    sawBinding.ok
      ? `contextId=${sawBinding.v.executionContextId} expected=${defaultCtx?.id} payload=${String(sawBinding.v.payload).slice(0, 60)}`
      : String(sawBinding.v),
  );

  if (sawBinding.ok) {
    const hostResolve = await race(
      cdp.send('Runtime.evaluate', {
        executionContextId: sawBinding.v.executionContextId,
        expression: `globalThis.__cb_probe.resolve('host-answer'); true`,
        returnByValue: true,
      }),
      6000,
      'host resolve of exposed callback',
    );
    add('host resolves the page callback while callFunctionOn is pending',
      hostResolve.ok, hostResolve.ok ? 'ok' : String(hostResolve.v));

    const final = await race(roundTripPromise, 6000, 'exposed function round trip');
    add(
      'FULL exposeFunction-equivalent round trip',
      final.ok && final.v?.value === 'host-answer',
      final.ok ? JSON.stringify(final.v) : String(final.v),
    );
  }

  out.bindingEvents = bindingEvents.map((e) => ({
    name: e.name,
    executionContextId: e.executionContextId,
    payload: String(e.payload).slice(0, 80),
    msAfterCall: e.at ? e.at - firedAt : null,
  }));
  await browser.disconnect();
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FATAL:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}10-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '10-session-serialization.json', out);
  console.log(`\nsaved ${path}`);
  console.log(
    `\ngate: ${out.tests.every((t) => t.ok) ? 'event channel PASS' : 'event channel FAIL'}`,
  );
}
