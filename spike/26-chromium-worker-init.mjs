#!/usr/bin/env node
/**
 * 26 — Chromium ground truth for the v4 worker bootstrap request.
 *
 * Obscura boots the page but the POST to
 *   /static_resources/webworker_v4/rsrc/?worker_module=WAWebBackendWorkerV2Bundle
 * comes back 400, so the backend worker never initializes and getDeviceInfo
 * never resolves. Capture the exact method, URL, headers and body Chromium
 * sends, plus the response status/body, to see what the edge requires.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { saveResult } from './lib/obscura.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const CHROME = '/home/hp/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome';
const out = { script: '26-chromium-worker-init', startedAt: new Date().toISOString(), requests: [] };

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  );
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');

  const byId = new Map();
  const interest = (url) => /worker_module|webworker_v4\/rsrc|WebWorkerV4/i.test(url);

  cdp.on('Network.requestWillBeSent', (e) => {
    if (!interest(e.request.url)) return;
    const entry = {
      id: e.requestId,
      method: e.request.method,
      url: e.request.url,
      headers: e.request.headers,
      postData: e.request.postData ?? null,
      hasPostData: !!e.request.hasPostData,
    };
    byId.set(e.requestId, entry);
    if (out.requests.length < 40) out.requests.push(entry);
  });
  cdp.on('Network.responseReceived', (e) => {
    const entry = byId.get(e.requestId);
    if (!entry) return;
    entry.status = e.response.status;
    entry.mimeType = e.response.mimeType;
  });
  cdp.on('Network.loadingFinished', async (e) => {
    const entry = byId.get(e.requestId);
    if (!entry || entry.body !== undefined) return;
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId: e.requestId });
      entry.body = (body.body || '').slice(0, 300);
      entry.bodyBytes = (body.body || '').length;
    } catch (err) {
      entry.bodyError = String(err.message || err);
    }
  });

  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 12_000));

  console.log('captured', out.requests.length, 'worker requests');
  for (const r of out.requests) {
    console.log(`\n${r.method} ${r.url}\n  status=${r.status} type=${r.mimeType} bodyLen=${r.bodyBytes ?? '?'}`);
    console.log('  postData=', r.postData);
    console.log('  headers=', JSON.stringify(r.headers));
    if (r.body) console.log('  bodyHead=', JSON.stringify(r.body.slice(0, 160)));
  }
} catch (e) {
  out.error = String(e.stack || e);
  console.error(out.error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await saveResult(resultsDir, '26-chromium-worker-init.json', out);
}
