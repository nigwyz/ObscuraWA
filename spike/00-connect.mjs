#!/usr/bin/env node
/**
 * G1 probe 1/3 — can puppeteer-core drive Obscura at all?
 *
 * No phone needed. Connects over CDP, loads a trivial page, evaluates JS,
 * captures a screenshot, and records the engine's process footprint.
 */
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import {
  ObscuraServer,
  connectPuppeteer,
  freePort,
  processTreeRss,
  saveResult,
  table,
} from './lib/obscura.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const storageDir = process.env.SPIKE_STORAGE_DIR ?? `${resultsDir}storage-00`;
const out = { script: '00-connect', startedAt: new Date().toISOString() };
const timings = {};

async function timed(name, fn) {
  const t0 = Date.now();
  const value = await fn();
  timings[name] = Date.now() - t0;
  return value;
}

const port = await freePort();
const server = new ObscuraServer({ port, storageDir });

try {
  await timed('serverStart', () => server.start());
  out.readyInfo = server.readyInfo;
  console.log(`obscura serving on ${server.wsEndpoint} (ready: ${server.readyInfo})`);

  const conn = await timed('cdpConnect', () => connectPuppeteer(port, puppeteer));
  out.endpoint = conn.endpoint;
  out.endpointAttempts = conn.attempts;
  out.version = conn.version;
  console.log(`connected via ${conn.endpoint}`);

  const browser = conn.browser;
  const page = await timed('newPage', () => browser.newPage());
  const ua = await page.evaluate(() => navigator.userAgent);
  out.userAgent = ua;

  await timed('gotoExample', async () => {
    await page.goto('https://example.com', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
  });
  out.title = await page.title();

  // CSP-sensitive evaluation: whatsapp-web.js injects code through
  // Runtime.evaluate, so this proves the injection path is usable.
  const evalProbe = await page.evaluate(() => {
    const el = document.querySelector('h1');
    return {
      h1: el ? el.textContent : null,
      box: (() => {
        const d = document.createElement('div');
        d.style.cssText = 'position:absolute;width:50px;height:50px';
        document.body.appendChild(d);
        const r = d.getBoundingClientRect();
        d.remove();
        return { w: r.width, h: r.height };
      })(),
      globalBindingTarget: typeof globalThis,
    };
  });
  out.evalProbe = evalProbe;

  await timed('screenshot', () =>
    page.screenshot({ path: `${resultsDir}00-example.png`, fullPage: true }),
  );

  // exposeFunction -> Runtime.addBinding is the channel whatsapp-web.js uses
  // for every event it surfaces to Node. NOTE: the host must never await a
  // promise that only the host can settle (Obscura serializes commands per
  // CDP session - see 10/11/12). whatsapp-web.js always resolves from the
  // page side, so this exercises the real pattern.
  let bindingFired = null;
  await page.exposeFunction('__spikePing', (arg) => `pong:${arg}`);
  await page.evaluate(() => {
    globalThis.__pingResult = 'pending';
    globalThis
      .__spikePing('hello')
      .then((r) => {
        globalThis.__pingResult = r;
      })
      .catch((e) => {
        globalThis.__pingResult = `error:${e.message}`;
      });
    return 'launched';
  });
  for (let i = 0; i < 30 && bindingFired === null; i++) {
    const v = await page.evaluate(() => globalThis.__pingResult).catch(() => 'pending');
    if (v && v !== 'pending') bindingFired = v;
    else await new Promise((r) => setTimeout(r, 250));
  }
  out.exposeFunction = bindingFired === 'pong:hello';

  timings['toPageRss'] = await timed('rss', async () => (await processTreeRss(server.child.pid)).totalMb);
  out.rss = await processTreeRss(server.child.pid);

  await browser.disconnect();
  out.timingsMs = timings;
  out.ok = true;
  console.log(
    `\nG1a CDP connect: OK\n  title: ${out.title}\n  ua: ${out.userAgent}\n  exposeFunction round-trip: ${bindingFired}\n  RSS after 1 page: ${out.rss.totalMb} MB`,
  );
} catch (err) {
  out.ok = false;
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}00-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '00-connect.json', out);
  console.log(`\nsaved ${path}`);
}
