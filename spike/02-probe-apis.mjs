#!/usr/bin/env node
/**
 * G2 — browser API battery against a real WhatsApp Web page.
 *
 * Runs the same probe set twice: once on a plain page (engine capability) and
 * once on web.whatsapp.com (capability in the context that matters).
 */
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import {
  ObscuraServer,
  connectPuppeteer,
  freePort,
  saveResult,
  table,
} from './lib/obscura.mjs';
import { apiProbe } from './lib/probe.mjs';

process.env.OBSCURA_SCRIPT_DEADLINE_MS ??= '60000';
process.env.OBSCURA_MODULE_BUDGET_MS ??= '15000';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const out = { script: '02-probe-apis', contexts: {} };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-02` });

async function runOn(page, label) {
  const results = await page.evaluate(apiProbe);
  out.contexts[label] = results;
  const criticalFailures = results.filter((r) => r.critical && !r.ok);
  console.log(`\n=== ${label} — ${results.length} probes, ${criticalFailures.length} critical failures`);
  console.log(
    table(
      results.map((r) => ({
        probe: r.name,
        crit: r.critical ? 'CRIT' : '',
        result: r.ok ? 'pass' : 'FAIL',
        ms: r.ms,
        detail: typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail),
      })),
    ),
  );
  return criticalFailures;
}

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);

  const plain = await browser.newPage();
  await plain.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  out.plainCriticalFailures = (await runOn(plain, 'example.com')).length;

  const wa = await browser.newPage();
  await wa.goto('https://web.whatsapp.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  });
  await new Promise((r) => setTimeout(r, 5000));
  out.whatsappCriticalFailures = (await runOn(wa, 'web.whatsapp.com')).length;

  console.log(
    `\nG2 critical failures: example.com=${out.plainCriticalFailures}  web.whatsapp.com=${out.whatsappCriticalFailures}`,
  );
  await browser.disconnect();
} catch (err) {
  out.ok = false;
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}02-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '02-probe-apis.json', out);
  console.log(`\nsaved ${path}`);
}
