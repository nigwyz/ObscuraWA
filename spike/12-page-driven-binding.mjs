#!/usr/bin/env node
/**
 * Realistic event-pattern test for Obscura + whatsapp-web.js.
 *
 * whatsapp-web.js never awaits, from the host, a promise that only the host
 * can settle (that is the deadlock in 10). Its real pattern is:
 *   - host installs the wrapper (short commands)
 *   - PAGE calls the exposed function whenever an event fires
 *   - host resolves the page's callback with a follow-up evaluate
 *
 * This tests that path, including the contention case: an event firing while
 * a long host command is in flight on the same session.
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
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-12` });
const out = { script: '12-page-driven-binding', tests: [] };
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

  // 1. Install an exposed function the same way whatsapp-web.js gets one.
  let received = null;
  const installed = await race(
    page.exposeFunction('__onEvent', (payload) => {
      received = payload;
      return `host-ack:${payload}`;
    }),
    10_000,
    'exposeFunction',
  );
  add('page.exposeFunction installs', installed.ok, installed.ok ? 'ok' : String(installed.v));
  if (!installed.ok) throw new Error('exposeFunction unavailable');

  // 2. PAGE-side call, fire-and-forget, host resolves asynchronously.
  const started = Date.now();
  const launched = await race(
    page.evaluate(() => {
      globalThis.__eventResult = 'pending';
      globalThis
        .__onEvent('message:hello')
        .then((r) => {
          globalThis.__eventResult = r;
        })
        .catch((e) => {
          globalThis.__eventResult = `error:${e.message}`;
        });
      return 'launched';
    }),
    8000,
    'page-side launch',
  );
  add('page-side exposeFunction call launches', launched.ok && launched.v === 'launched',
    String(launched.v));

  // 3. Poll for the settled value - this is the whatsapp-web.js event path.
  let settled = null;
  for (let i = 0; i < 40 && settled === null; i++) {
    const poll = await race(
      page.evaluate(() => globalThis.__eventResult),
      5000,
      'poll',
    );
    if (!poll.ok) break;
    if (poll.v !== 'pending' && poll.v !== null) settled = poll.v;
    else await new Promise((r) => setTimeout(r, 250));
  }
  add(
    'page -> host -> page callback resolves (whatsapp-web.js event path)',
    settled === 'host-ack:message:hello',
    `result=${JSON.stringify(settled)} after ${Date.now() - started}ms; host saw payload=${JSON.stringify(received)}`,
  );

  // 4. Contention: fire an event while a long host command is in flight on
  //    the same session. Events must not be lost or starved.
  const contendedStart = Date.now();
  const busy = race(
    page.evaluate(() => {
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) {
        /* hold the session for 1.5s */
      }
      return 'busy-done';
    }),
    10_000,
    'busy evaluate',
  );
  await new Promise((r) => setTimeout(r, 150));
  const duringBusy = await race(
    page.evaluate(() => {
      globalThis.__eventResult2 = 'pending';
      globalThis.__onEvent('during-busy').then((r) => {
        globalThis.__eventResult2 = r;
      });
      return 'launched';
    }),
    8000,
    'event during busy command',
  );
  const busyResult = await busy;
  add('long host command still completes', busyResult.ok, String(busyResult.v));

  let settled2 = null;
  for (let i = 0; i < 40 && settled2 === null; i++) {
    const poll = await race(
      page.evaluate(() => globalThis.__eventResult2),
      5000,
      'poll2',
    );
    if (!poll.ok) break;
    if (poll.v !== 'pending' && poll.v !== null) settled2 = poll.v;
    else await new Promise((r) => setTimeout(r, 250));
  }
  add(
    'event fired during a busy host command still round-trips',
    settled2 === 'host-ack:during-busy',
    `result=${JSON.stringify(settled2)} total ${Date.now() - contendedStart}ms`,
  );

  // 5. Many events in a burst (WhatsApp fires several events back to back).
  await page.evaluate(() => {
    globalThis.__burst = [];
    for (let i = 0; i < 25; i++) {
      globalThis.__onEvent(`burst-${i}`).then((r) => globalThis.__burst.push(r));
    }
    return 'fired';
  });
  let burst = null;
  for (let i = 0; i < 60 && (burst === null || burst.length < 25); i++) {
    const poll = await race(page.evaluate(() => globalThis.__burst), 5000, 'burst poll');
    if (!poll.ok) break;
    burst = poll.v;
    if (Array.isArray(burst) && burst.length >= 25) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  add(
    'burst of 25 events all round-trips',
    Array.isArray(burst) && burst.length === 25,
    `received ${Array.isArray(burst) ? burst.length : 'none'} of 25`,
  );

  await browser.disconnect();
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FATAL:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}12-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '12-page-driven-binding.json', out);
  console.log(`\nsaved ${path}`);
  console.log(
    `\ngate: ${out.tests.every((t) => t.ok) ? 'event channel PASS' : 'event channel FAIL'}`,
  );
}
