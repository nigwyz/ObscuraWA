#!/usr/bin/env node
/**
 * Focused compatibility probe: the event channel.
 *
 * whatsapp-web.js routes every event it exposes (qr, message, message_ack,
 * disconnected, ...) through `page.exposeFunction`, which in CDP terms is
 * `Runtime.addBinding` + a page->host round trip. If this channel is broken,
 * the whole WhatsApp Web adapter model is broken on Obscura regardless of
 * whether the app boots.
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
const server = new ObscuraServer({
  port,
  storageDir: `${resultsDir}storage-08`,
  extraArgs: ['--verbose'],
});
const out = { script: '08-binding-test', steps: [] };

const record = (name, ok, detail) => {
  out.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const cdp = await page.createCDPSession();
  await cdp.send('Runtime.enable');

  // Capture every Runtime event Obscura emits so we can see what it does
  // and does not implement.
  const events = [];
  cdp.on('Runtime.bindingCalled', (ev) =>
    events.push({ t: 'bindingCalled', name: ev.name, payload: ev.payload }),
  );
  cdp.on('Runtime.exceptionThrown', (ev) =>
    events.push({
      t: 'exceptionThrown',
      text: ev.exceptionDetails?.exception?.description ?? ev.exceptionDetails?.text,
    }),
  );
  cdp.on('Runtime.consoleAPICalled', (ev) =>
    events.push({ t: 'consoleAPICalled', type: ev.type }),
  );

  // 1. Runtime.addBinding
  try {
    await cdp.send('Runtime.addBinding', { name: 'spikeBinding' });
    record('Runtime.addBinding', true);
  } catch (err) {
    record('Runtime.addBinding', false, String(err.message || err));
  }

  // 2. Does the page see the binding, and does calling it reach the host?
  try {
    const sees = await cdp.send('Runtime.evaluate', {
      expression: 'typeof window.spikeBinding',
      returnByValue: true,
    });
    record(
      'binding visible in page',
      sees.result.value === 'function',
      `typeof = ${sees.result.value}`,
    );
    if (sees.result.value === 'function') {
      await cdp.send('Runtime.evaluate', {
        expression: "window.spikeBinding('hello-from-page')",
        returnByValue: true,
      });
      await new Promise((r) => setTimeout(r, 1000));
      const fired = events.find((e) => e.name === 'spikeBinding');
      record(
        'page->host bindingCalled event',
        Boolean(fired),
        fired ? `payload=${fired.payload}` : `events so far: ${JSON.stringify(events)}`,
      );
    }
  } catch (err) {
    record('page->host binding call', false, String(err.message || err));
  }

  // 3. Runtime.evaluate with awaitPromise on a real promise.
  try {
    const started = Date.now();
    const res = await Promise.race([
      cdp.send('Runtime.evaluate', {
        expression: 'new Promise((r) => setTimeout(() => r(42), 100))',
        awaitPromise: true,
        returnByValue: true,
      }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('awaitPromise timeout')), 15_000),
      ),
    ]);
    record(
      'Runtime.evaluate awaitPromise',
      res.result.value === 42,
      `value=${res.result.value} in ${Date.now() - started}ms`,
    );
  } catch (err) {
    record('Runtime.evaluate awaitPromise', false, String(err.message || err));
  }

  // 4. Runtime.callFunctionOn returning a promise.
  try {
    const started = Date.now();
    const { objectId } = await cdp.send('Runtime.evaluate', {
      expression: 'window',
    });
    const res = await Promise.race([
      cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { return Promise.resolve("cfo-ok"); }',
        awaitPromise: true,
        returnByValue: true,
      }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('callFunctionOn timeout')), 15_000),
      ),
    ]);
    record(
      'Runtime.callFunctionOn awaitPromise',
      res.result.value === 'cfo-ok',
      `value=${res.result.value} in ${Date.now() - started}ms`,
    );
  } catch (err) {
    record('Runtime.callFunctionOn awaitPromise', false, String(err.message || err));
  }

  // 5. Runtime.callFunctionOn whose promise resolves only after a binding
  //    round trip - this is exactly what page.exposeFunction generates.
  try {
    const started = Date.now();
    const bindingResult = await Promise.race([
      page.exposeFunction('__spikeEcho', (arg) => `host-echo:${arg}`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('exposeFunction timeout')), 15_000)),
    ]).then(() => true, (e) => e);
    record(
      'page.exposeFunction registration',
      bindingResult === true,
      String(bindingResult),
    );

    if (bindingResult === true) {
      const value = await Promise.race([
        page.evaluate(async () => globalThis.__spikeEcho('ping')),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('exposed call timeout')), 15_000),
        ),
      ]);
      record(
        'page -> exposeFunction -> host -> page round trip',
        value === 'host-echo:ping',
        `value=${JSON.stringify(value)} in ${Date.now() - started}ms`,
      );
    }
  } catch (err) {
    record('page.exposeFunction round trip', false, String(err.message || err));
  }

  out.obscuraEvents = events;
  out.obscuraLogExcerpt = server.logs.split('\n').filter((l) => /error|warn|Unknown/i.test(l)).slice(0, 20);
  await browser.disconnect();
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FATAL:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}08-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '08-binding-test.json', out);
  console.log(`\nsaved ${path}`);
  console.log(
    `\ngate: ${out.steps.every((s) => s.ok) ? 'G2 event channel PASS' : 'G2 event channel FAIL'}`,
  );
}
