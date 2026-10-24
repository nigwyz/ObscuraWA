#!/usr/bin/env node
/**
 * 22 — ground truth for the WhatsApp WebSocket handshake.
 *
 * The CDP tunnel in spike/18 now carries real traffic, but the sequence is:
 *   client 43 bytes (0x57 'W') -> server 350 bytes (0x00) -> server 4 bytes
 *   (0x88) -> connection drops, client retries.
 * The client never sends a finish frame, so it is not processing the server
 * hello. This captures the same handshake from real Chromium over CDP so we
 * can compare lengths and first bytes without guessing at the Noise protocol.
 *
 * Only frame lengths and first bytes are recorded, never payloads.
 */
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { saveResult } from './lib/obscura.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const CHROME = '/home/hp/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome';
const out = { script: '22-chromium-ws-frames', startedAt: new Date().toISOString(), frames: [] };

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

  const firstByte = (payload) => {
    if (typeof payload !== 'string') return null;
    try {
      return Buffer.from(payload, 'base64')[0] ?? null;
    } catch {
      return null;
    }
  };

  cdp.on('Network.webSocketCreated', (e) => {
    if (out.frames.length < 200) out.frames.push({ ev: 'created', url: e.url });
  });
  cdp.on('Network.webSocketFrameSent', (e) => {
    if (out.frames.length >= 200) return;
    out.frames.push({
      ev: 'sent',
      len: e.response.payloadData ? Buffer.from(e.response.payloadData, 'base64').length : 0,
      b0: firstByte(e.response.payloadData),
    });
  });
  cdp.on('Network.webSocketFrameReceived', (e) => {
    if (out.frames.length >= 200) return;
    out.frames.push({
      ev: 'recv',
      len: e.response.payloadData ? Buffer.from(e.response.payloadData, 'base64').length : 0,
      b0: firstByte(e.response.payloadData),
    });
  });
  cdp.on('Network.webSocketClosed', () => {
    if (out.frames.length < 200) out.frames.push({ ev: 'closed' });
  });

  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  // Give the app time to run its socket handshake.
  await new Promise((r) => setTimeout(r, 25_000));

  out.qrPresent = await page.evaluate(
    () => Boolean(document.querySelector('canvas')) || document.body.innerText.includes('Scan to log in'),
  );
  out.summary = out.frames.slice(0, 24);

  console.log(out.summary.map((f) => JSON.stringify(f)).join('\n'));
  console.log(`\nQR/login present: ${out.qrPresent}`);
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  await browser.close().catch(() => {});
  const path = await saveResult(resultsDir, '22-chromium-ws-frames.json', out);
  console.log(`saved ${path}`);
}
