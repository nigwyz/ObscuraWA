#!/usr/bin/env node
/**
 * 20 — is Obscura's WebSocket a real transport?
 *
 * spike/18 gets WhatsApp Web to its login screen, but the QR never paints:
 * the app opens wss://web.whatsapp.com/ws/chat, reports OPEN, and receives
 * nothing. Reading crates/obscura-js/js/bootstrap.js shows why —
 *
 *     send(data) { "drop; no real socket" }
 *
 * and the constructor only flips readyState to OPEN on a microtask. This probe
 * proves it against a public echo server rather than trusting the source.
 */
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { freePort, ObscuraServer, connectPuppeteer, saveResult } from './lib/obscura.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const out = { script: '20-websocket-probe', startedAt: new Date().toISOString() };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-20` });

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();

  // 1. Local echo semantics: does send() ever come back?
  out.echo = await page.evaluate(async () => {
    const ENDPOINT = 'wss://ws.postman-echo.com/raw';
    const rec = { endpoint: ENDPOINT, events: [], sentAt: null, gotReply: false };
    await new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(ENDPOINT);
      } catch (e) {
        rec.constructError = String(e.message || e);
        resolve();
        return;
      }
      rec.readyStateAtConstruct = ws.readyState;
      ws.onopen = () => {
        rec.events.push({ type: 'open', readyState: ws.readyState, at: Date.now() });
        rec.sentAt = Date.now();
        try {
          ws.send('obscura-probe');
          rec.sendReturned = true;
        } catch (e) {
          rec.sendError = String(e.message || e);
        }
      };
      ws.onmessage = (ev) => {
        rec.gotReply = true;
        rec.events.push({ type: 'message', len: String(ev.data ?? '').length });
      };
      ws.onerror = () => rec.events.push({ type: 'error' });
      ws.onclose = (ev) => rec.events.push({ type: 'close', code: ev.code, reason: ev.reason });
      setTimeout(() => {
        rec.readyStateAfter5s = ws.readyState;
        rec.closeReturned = (() => {
          try {
            ws.close();
            return true;
          } catch (e) {
            return String(e.message || e);
          }
        })();
        setTimeout(resolve, 300);
      }, 5000);
    });
    return rec;
  });

  // 2. Does WhatsApp's actual endpoint even produce a server hello?
  out.whatsapp = await page.evaluate(async () => {
    const rec = { events: [], messages: 0 };
    await new Promise((resolve) => {
      const ws = new WebSocket('wss://web.whatsapp.com/ws/chat');
      ws.onopen = () => rec.events.push({ type: 'open' });
      ws.onmessage = () => {
        rec.messages += 1;
      };
      ws.onerror = () => rec.events.push({ type: 'error' });
      ws.onclose = (e) => rec.events.push({ type: 'close', code: e.code, reason: e.reason });
      setTimeout(() => {
        rec.readyState = ws.readyState;
        resolve();
      }, 6000);
    });
    return rec;
  });

  const echoOk = out.echo.gotReply === true;
  console.log(
    [
      `echo endpoint: ${out.echo.endpoint}`,
      `  readyState at construct: ${out.echo.readyStateAtConstruct} (0=CONNECTING)`,
      `  events: ${JSON.stringify(out.echo.events)}`,
      `  send() returned: ${out.echo.sendReturned}, reply received: ${echoOk}`,
      `whatsapp.com/ws/chat: ${JSON.stringify(out.whatsapp.events)}, messages received: ${out.whatsapp.messages}, readyState: ${out.whatsapp.readyState}`,
      '',
      echoOk
        ? 'VERDICT: WebSocket carries data.'
        : 'VERDICT: WebSocket is a stub - send() is dropped and no server frame ever arrives.',
    ].join('\n'),
  );

  await browser.disconnect();
} catch (err) {
  out.ok = false;
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}20-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '20-websocket-probe.json', out);
  console.log(`\nsaved ${path}`);
}
