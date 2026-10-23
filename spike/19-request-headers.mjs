#!/usr/bin/env node
/**
 * 19 — what headers does Obscura actually put on the wire?
 *
 * spike/18 moved the boot blocker from "worker globals" to "fetching the worker
 * script returns WhatsApp's 400 page", while the identical URL returns 200 from
 * curl. That points at request headers rather than the URL, so this probe asks
 * a public echo endpoint what the engine sent for:
 *   - a top-level navigation
 *   - fetch()
 *   - XMLHttpRequest
 *   - an <img> subresource
 *
 * A loopback server would be the clean way to do this, but Obscura's SSRF guard
 * refuses private IPs, so the echo service is the only observable channel.
 */
import { mkdir } from 'node:fs/promises';
import { freePort, ObscuraServer, connectPuppeteer, saveResult } from './lib/obscura.mjs';
import puppeteer from 'puppeteer-core';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const ECHO = 'https://httpbin.org/anything';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const out = { script: '19-request-headers', startedAt: new Date().toISOString() };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-19` });

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();
  await page.setUserAgent(UA);

  const nav = await page
    .goto(`${ECHO}?via=navigation`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    .then(() => 'ok')
    .catch((e) => `error: ${String(e.message || e).slice(0, 200)}`);
  out.navigation = nav;

  if (nav === 'ok') {
    out.navigationHeaders = await page
      .evaluate(() => {
        try {
          return JSON.parse(document.body.innerText).headers;
        } catch (e) {
          return { parseError: String(e.message || e) };
        }
      })
      .catch((e) => ({ probeError: String(e.message || e) }));

    out.subresource = await page.evaluate(async (echo) => {
      const out = {};
      out.pageUA = navigator.userAgent;
      try {
        const r = await fetch(`${echo}?via=fetch`, { credentials: 'include' });
        out.fetch = (await r.json()).headers;
      } catch (e) {
        out.fetch = { error: String(e.message || e) };
      }
      await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `${echo}?via=xhr`, true);
        xhr.onload = () => {
          try {
            out.xhr = JSON.parse(xhr.responseText).headers;
          } catch (e) {
            out.xhr = { parseError: String(e.message || e) };
          }
          resolve();
        };
        xhr.onerror = () => {
          out.xhr = { error: 'xhr error' };
          resolve();
        };
        xhr.send();
      });
      // Can page JS synthesise the headers the engine omits? In a real browser
      // these are forbidden header names; if Obscura lets them through, the
      // worker loader can stay a JS prelude instead of a Rust patch.
      await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `${echo}?via=forged`, true);
        const forged = {
          'User-Agent': navigator.userAgent,
          Referer: location.href,
          Origin: location.origin,
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Ch-Ua': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Linux"',
        };
        for (const [k, v] of Object.entries(forged)) {
          try {
            xhr.setRequestHeader(k, v);
          } catch (e) {
            (out.forgedSetErrors ??= []).push(`${k}: ${String(e.message || e)}`);
          }
        }
        xhr.onload = () => {
          try {
            out.forged = JSON.parse(xhr.responseText).headers;
          } catch (e) {
            out.forged = { parseError: String(e.message || e) };
          }
          resolve();
        };
        xhr.onerror = () => {
          out.forged = { error: 'xhr error' };
          resolve();
        };
        xhr.send();
      });
      return out;
    }, ECHO);
  }

  const pick = (h) =>
    h && !h.error && !h.probeError
      ? {
          ua: h['User-Agent'] ?? h['user-agent'] ?? null,
          accept: h.Accept ?? h.accept ?? null,
          language: h['Accept-Language'] ?? h['accept-language'] ?? null,
          referer: h.Referer ?? h.referer ?? null,
          origin: h.Origin ?? h.origin ?? null,
          secFetchSite: h['Sec-Fetch-Site'] ?? h['sec-fetch-site'] ?? null,
          secFetchMode: h['Sec-Fetch-Mode'] ?? h['sec-fetch-mode'] ?? null,
          secChUa: h['Sec-Ch-Ua'] ?? h['sec-ch-ua'] ?? null,
          encoding: h['Accept-Encoding'] ?? h['accept-encoding'] ?? null,
        }
      : { error: h?.error ?? h?.probeError ?? 'unavailable' };

  out.summary = {
    configuredUA: UA,
    navigation: pick(out.navigationHeaders),
    fetch: pick(out.subresource?.fetch),
    xhr: pick(out.subresource?.xhr),
    forged: pick(out.subresource?.forged),
    forgedSetErrors: out.subresource?.forgedSetErrors ?? [],
    pageUA: out.subresource?.pageUA ?? null,
  };

  console.log(
    [
      `navigation: ${nav}`,
      `configured UA: ${UA}`,
      `page navigator.userAgent: ${out.summary.pageUA}`,
      `nav    ua=${JSON.stringify(out.summary.navigation.ua)}`,
      `fetch  ua=${JSON.stringify(out.summary.fetch.ua)} sec-fetch-site=${JSON.stringify(
        out.summary.fetch.secFetchSite,
      )} origin=${JSON.stringify(out.summary.fetch.origin)}`,
      `xhr    ua=${JSON.stringify(out.summary.xhr.ua)} referer=${JSON.stringify(
        out.summary.xhr.referer,
      )}`,
      `forged ua=${JSON.stringify(out.summary.forged.ua)} referer=${JSON.stringify(
        out.summary.forged.referer,
      )} sec-fetch-site=${JSON.stringify(out.summary.forged.secFetchSite)}`,
      `forged header errors: ${JSON.stringify(out.summary.forgedSetErrors)}`,
      `accept-language nav/fetch: ${JSON.stringify(out.summary.navigation.language)} / ${JSON.stringify(
        out.summary.fetch.language,
      )}`,
    ].join('\n'),
  );

  await browser.disconnect();
} catch (err) {
  out.ok = false;
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}19-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '19-request-headers.json', out);
  console.log(`\nsaved ${path}`);
}
