#!/usr/bin/env node
/**
 * 21 — gate for the WebSocket tunnel.
 *
 * Before pointing the tunnel at WhatsApp, prove it carries bytes end to end:
 * open a real socket through spike/lib/ws-bridge.mjs, send a payload, and
 * require the echo to come back to page JS.
 *
 * Threading note: page promises that await a host binding cannot be awaited
 * with page.evaluate(). CDP serializes commands per session (spike/10), so
 * evaluate() would hold the session the binding needs to answer. The test is
 * therefore fire-and-forget: page code writes to window.__t, the host polls it.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';
import { freePort, ObscuraServer, connectPuppeteer, saveResult } from './lib/obscura.mjs';
import { installWsBridge } from './lib/ws-bridge.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const shimSource = await readFile(new URL('./lib/ws-shim.js', import.meta.url), 'utf8');
const TEST_SRC = await readFile(new URL('./lib/ws-gate.js', import.meta.url), 'utf8');

// A loopback echo server: the host dials it, so the page never needs a private
// IP (Obscura's SSRF guard rejects those) and the test has no external moving
// parts.
const echoServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => echoServer.once('listening', r));
const echoPort = echoServer.address().port;
echoServer.on('connection', (ws) => {
  ws.on('message', (data) => ws.send(Buffer.from('echo:' + data.toString())));
});

const out = { script: '21-ws-tunnel', startedAt: new Date().toISOString(), echoEndpoint: `ws://127.0.0.1:${echoPort}/` };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-21` });

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  );
  // Bindings must exist before the first document script.
  const bridge = await installWsBridge(page);
  await page.evaluateOnNewDocument(shimSource);
  await page.evaluateOnNewDocument(TEST_SRC);
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  out.bridgeInstalled = true;

  // Kick off, then read state — never await a page promise that needs a binding.
  await page.evaluate((endpoint) => {
    window.__ECHO_URL = endpoint;
    window.__startWsGate();
  }, out.echoEndpoint);

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    out.state = await page.evaluate(() => window.__t);
    if (out.state?.done) break;
    await sleep(500);
  }

  // Read host stats without awaiting a binding promise inside evaluate.
  await page.evaluate(() => {
    window.__bridgeStats = null;
    Promise.resolve(window.__obscuraWsStats()).then((v) => {
      window.__bridgeStats = v;
    });
  });
  await sleep(600);
  out.bridgeStats = await page
    .evaluate(() => window.__bridgeStats)
    .catch((e) => ({ probeError: String(e.message || e) }));
  out.shimDiag = await page
    .evaluate(() => {
      const d = window.__obscuraWsShim;
      if (!d) return null;
      return {
        created: d.created,
        sent: d.sent,
        sentBytes: d.sentBytes,
        received: d.received,
        receivedBytes: d.receivedBytes,
        maxFrame: d.maxFrame,
        errors: d.errors.slice(0, 10),
      };
    })
    .catch((e) => ({ probeError: String(e.message || e) }));

  // The tunnel gate is: page -> host (sent) and host -> page (server frame).
  const waEvents = out.state?.wa?.events ?? [];
  const pass = out.state?.wa?.sent === true && waEvents.includes('message');
  out.pass = pass;

  console.log(
    [
      `echo: ${JSON.stringify(out.state?.echo)}`,
      `whatsapp: ${JSON.stringify(out.state?.wa)}`,
      `shim: sent=${out.shimDiag?.sent} bytes=${out.shimDiag?.sentBytes} recv=${out.shimDiag?.received} bytes=${out.shimDiag?.receivedBytes} errors=${JSON.stringify(
        out.shimDiag?.errors,
      )}`,
      `bridge: ${JSON.stringify(out.bridgeStats)}`,
      '',
      pass ? 'GATE PASS: the tunnel carries bytes both ways.' : 'GATE FAIL: see events above.',
    ].join('\n'),
  );

  await bridge.dispose();
  await new Promise((r) => echoServer.close(r));
  await browser.disconnect();
  if (!pass) process.exitCode = 1;
} catch (err) {
  out.ok = false;
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
  process.exitCode = 1;
} finally {
  await server.writeLogs(`${resultsDir}21-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '21-ws-tunnel.json', out);
  console.log(`\nsaved ${path}`);
}
