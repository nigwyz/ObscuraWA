#!/usr/bin/env node
// Does the backend worker bundle fetch succeed from the page with forged
// Sec-Fetch headers and the page's cookies? The v4 init script loads it with a
// native dynamic import(), which bypasses our header-forging XHR and 400s.
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { ObscuraServer, connectPuppeteer, freePort, saveResult } from './lib/obscura.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });
const port = await freePort();
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-25` });
const out = { script: '25-worker-bundle-probe', startedAt: new Date().toISOString() };

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();
  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await new Promise((r) => setTimeout(r, 1500));

  out.probes = await page.evaluate(async () => {
    const url = 'https://web.whatsapp.com/static_resources/webworker_v4/rsrc/?worker_module=WAWebBackendWorkerV2Bundle';
    const ua = navigator.userAgent;
    const headers = {
      Accept: '*/*',
      Referer: location.href,
      'Sec-Fetch-Dest': 'worker',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    };
    const viaXhr = (withHeaders, withCreds) =>
      new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.withCredentials = !!withCreds;
        if (withHeaders) for (const k in headers) { try { xhr.setRequestHeader(k, headers[k]); } catch (e) {} }
        xhr.onload = () => resolve({ status: xhr.status, len: xhr.responseText.length, head: xhr.responseText.slice(0, 60) });
        xhr.onerror = () => resolve({ error: 'xhr error' });
        xhr.ontimeout = () => resolve({ error: 'xhr timeout' });
        xhr.send();
      });
    const viaPost = (withHeaders, useFormData) =>
      new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.withCredentials = true;
        if (withHeaders) {
          for (const k in headers) { try { xhr.setRequestHeader(k, headers[k]); } catch (e) {} }
          xhr.setRequestHeader('Accept', '*/*');
        }
        xhr.onload = () => resolve({ status: xhr.status, len: xhr.responseText.length, head: xhr.responseText.slice(0, 80) });
        xhr.onerror = () => resolve({ error: 'xhr error' });
        let body;
        if (useFormData) {
          body = new FormData();
          body.set('__rev', 'null');
          body.set('__spin_r', 'null');
        } else {
          body = '__rev=null&__spin_r=null';
          try { xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8'); } catch (e) {}
        }
        xhr.send(body);
      });
    return {
      ua,
      bare: await viaXhr(false, false),
      headersNoCreds: await viaXhr(true, false),
      headersCreds: await viaXhr(true, true),
      postBare: await viaPost(false, false),
      postHeaders: await viaPost(true, false),
      postHeadersForm: await viaPost(true, true),
    };
  });
  console.log(JSON.stringify(out.probes, null, 1));
  await browser.disconnect();
} catch (e) {
  out.error = String(e.stack || e);
  console.error(out.error);
  process.exitCode = 1;
} finally {
  await server.stop();
  await saveResult(resultsDir, '25-worker-bundle-probe.json', out);
}
