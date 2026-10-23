#!/usr/bin/env node
/**
 * Root-cause probe for the exposeFunction hang seen in 08.
 *
 * puppeteer-core's ExecutionContext.#onBindingCalled does:
 *     if (event.executionContextId !== this.#id) return;
 * where `this.#id` comes from Runtime.executionContextCreated. If Obscura
 * reports a different/absent executionContextId on Runtime.bindingCalled,
 * every exposed function silently dies and every WhatsApp event is lost.
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
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-09` });
const out = { script: '09-binding-context' };

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const cdp = await page.createCDPSession();
  await cdp.send('Runtime.enable');

  const contexts = [];
  const bindingCalls = [];
  cdp.on('Runtime.executionContextCreated', (ev) => contexts.push(ev.context));
  cdp.on('Runtime.executionContextsCleared', () => contexts.splice(0));
  cdp.on('Runtime.bindingCalled', (ev) => bindingCalls.push(ev));
  // Re-enable to be sure we get the events even if they fired before attach.
  await cdp.send('Runtime.disable').catch(() => {});
  await cdp.send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 300));

  out.contexts = contexts.map((c) => ({
    id: c.id,
    name: c.name ?? null,
    origin: c.origin ?? null,
    auxData: c.auxData ?? null,
  }));

  // Register a binding scoped to the main world, exactly like puppeteer does
  // for an exposed function.
  const mainContext = contexts.find((c) => !c.name || c.auxData?.type === 'default');
  out.mainContextId = mainContext?.id ?? null;

  await cdp.send('Runtime.addBinding', {
    name: 'puppeteer_probe',
    ...(mainContext ? { executionContextId: mainContext.id } : {}),
  });
  out.addBindingWithExecutionContextId = true;

  const wrapper = `
    (() => {
      const name = 'probe';
      const prefix = 'puppeteer_';
      if (globalThis[name]) return 'already';
      Object.assign(globalThis, {
        [name](...args) {
          globalThis[prefix + name](JSON.stringify({ type: 'exposedFun', name, seq: 1, args }));
          return new Promise((resolve) => {
            globalThis['__resolve_' + name] = resolve;
          });
        },
      });
      return 'installed';
    })()
  `;
  const install = await cdp.send('Runtime.evaluate', {
    expression: wrapper,
    returnByValue: true,
  });
  out.wrapperInstall = {
    value: install.result?.value,
    exception: install.exceptionDetails?.text ?? null,
  };

  // Fire the binding without awaiting, then see whether the host event arrives
  // and what executionContextId it carries.
  await cdp.send('Runtime.evaluate', {
    expression: "globalThis.probe('ping').catch(()=>{})",
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1500));

  out.bindingCalls = bindingCalls.map((e) => ({
    name: e.name,
    executionContextId: e.executionContextId,
    payload: String(e.payload).slice(0, 120),
  }));

  const expected = out.mainContextId;
  const matching = bindingCalls.filter((e) => e.executionContextId === expected);
  out.diagnosis = {
    expectedExecutionContextId: expected,
    bindingCalledExecutionContextIds: [...new Set(bindingCalls.map((e) => e.executionContextId))],
    anyMatch: matching.length > 0,
    missingExecutionContextId: bindingCalls.some((e) => e.executionContextId === undefined),
  };

  // Does a promise returned to puppeteer ever settle?
  const settled = await Promise.race([
    page
      .evaluate(async () => globalThis.probe('ping2'))
      .then((v) => ({ settled: true, v: String(v) })),
    new Promise((r) => setTimeout(() => r({ settled: false, v: 'timeout after 12s' }), 12_000)),
  ]);
  out.pageEvaluatePromise = settled;

  await browser.disconnect();
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FATAL:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}09-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '09-binding-context.json', out);
  console.log(JSON.stringify(out, null, 2));
  console.log(`\nsaved ${path}`);
}
