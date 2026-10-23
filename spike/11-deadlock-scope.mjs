#!/usr/bin/env node
/**
 * Scope of the command-serialization deadlock found in 10.
 *
 * While a `Runtime.callFunctionOn {awaitPromise:true}` awaits a promise that
 * only the host can settle, which of these can still be served?
 *   (a) another command on the SAME CDP session
 *   (b) another command on a DIFFERENT CDP session of the same page
 *   (c) a command over a SECOND browser connection (separate WebSocket)
 *
 * (a) alone = puppeteer's page.exposeFunction is unusable as-is.
 * (b) working = a shim is possible (route the resolve through session 2).
 * (c) working only = needs a second connection, much harder to wire into puppeteer.
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
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-11` });
const out = { script: '11-deadlock-scope', tests: [] };
const add = (name, ok, detail) => {
  out.tests.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const race = (promise, ms, label) =>
  Promise.race([
    promise.then((v) => ({ ok: true, v })),
    new Promise((r) =>
      setTimeout(() => r({ ok: false, v: `timeout after ${ms}ms (${label})` }), ms),
    ),
  ]);

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const sessionA = await page.createCDPSession();
  await sessionA.send('Runtime.enable');
  const { objectId } = await sessionA.send('Runtime.evaluate', {
    expression: 'window',
  });
  await sessionA.send('Runtime.evaluate', {
    expression: 'globalThis.__block = new Promise(() => {}); true',
    returnByValue: true,
  });

  // Start the blocking command on session A; it never settles.
  const blocking = sessionA
    .send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'async function () { return await globalThis.__block; }',
      awaitPromise: true,
      returnByValue: true,
    })
    .then(() => 'resolved-unexpectedly')
    .catch((e) => `error:${e.message}`);
  await new Promise((r) => setTimeout(r, 400));

  // (a) same session
  const sameSession = await race(
    sessionA.send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true }),
    6000,
    'same session',
  );
  add('(a) same CDP session serves a command while pending', sameSession.ok,
    sameSession.ok ? `value=${sameSession.v.result?.value}` : String(sameSession.v));

  // (b) different session, same page, same browser connection
  const sessionB = await page.createCDPSession();
  await sessionB.send('Runtime.enable').catch(() => {});
  const otherSession = await race(
    sessionB.send('Runtime.evaluate', { expression: '2 + 2', returnByValue: true }),
    6000,
    'other session',
  );
  add('(b) different CDP session on the same page serves a command while pending',
    otherSession.ok,
    otherSession.ok ? `value=${otherSession.v.result?.value}` : String(otherSession.v));

  // (c) second browser connection (its own WebSocket)
  let browser2 = null;
  try {
    const second = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}` });
    const page2 = await second.newPage();
    await page2.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const otherConn = await race(
      page2.evaluate(() => 3 + 3),
      6000,
      'second connection',
    );
    add('(c) second browser connection serves a command while pending', otherConn.ok,
      otherConn.ok ? `value=${otherConn.v}` : String(otherConn.v));
    browser2 = second;
  } catch (err) {
    add('(c) second browser connection serves a command while pending', false,
      String(err.message || err));
  }

  // Does the page-side binding event still arrive on the blocked session?
  const bindingArrived = await race(
    (async () => {
      const seen = [];
      sessionA.on('Runtime.bindingCalled', (ev) => seen.push(ev));
      await sessionA.send('Runtime.addBinding', { name: 'scopeProbe' });
      await sessionA.send('Runtime.evaluate', {
        expression: "globalThis.scopeProbe && globalThis.scopeProbe('x'); typeof globalThis.scopeProbe",
        returnByValue: true,
      });
      while (!seen.length) await new Promise((r) => setTimeout(r, 50));
      return seen[0];
    })().catch((e) => ({ error: String(e.message || e) })),
    6000,
    'bindingCalled on blocked session',
  );
  add('binding event can be registered and fired on the blocked session',
    bindingArrived.ok && !bindingArrived.v?.error,
    bindingArrived.ok ? `payload=${String(bindingArrived.v.payload).slice(0, 40)}` : String(bindingArrived.v));

  // Cleanup: nothing can unblock session A from inside it; teardown below
  // kills the server process. Just make sure the floating promise is harmless.
  blocking.catch(() => {});

  if (browser2) await browser2.disconnect();
  await browser.disconnect();
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FATAL:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}11-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '11-deadlock-scope.json', out);
  console.log(`\nsaved ${path}`);
  // Background probes may still be waiting on a blocked session; force exit.
  setTimeout(() => process.exit(0), 500);
}
