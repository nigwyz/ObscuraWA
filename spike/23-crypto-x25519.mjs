#!/usr/bin/env node
/**
 * 23 — does Obscura's webcrypto support the primitives Noise needs?
 *
 * WhatsApp's handshake is Noise over Curve25519. spike/02 only probed ECDSA
 * (which fails); X25519/Ed25519 were never tested, and the frame trace suggests
 * the page receives the server hello but never produces its finish frame —
 * consistent with a key-derivation step failing quietly.
 *
 * This runs the primitives directly so the answer is a measurement, not a
 * guess.
 */
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { freePort, ObscuraServer, connectPuppeteer, saveResult } from './lib/obscura.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const out = { script: '23-crypto-x25519', startedAt: new Date().toISOString(), probes: [] };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-23` });

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });

  out.probes = await page.evaluate(async () => {
    const results = [];
    const rec = async (name, fn) => {
      const started = Date.now();
      try {
        const detail = await fn();
        results.push({ name, ok: true, ms: Date.now() - started, detail });
      } catch (e) {
        results.push({
          name,
          ok: false,
          ms: Date.now() - started,
          detail: String((e && (e.name + ': ' + e.message)) || e),
        });
      }
    };

    const subtle = crypto.subtle;

    await rec('subtle present', async () => typeof subtle === 'object' && subtle !== null);

    await rec('X25519 generateKey', async () => {
      const kp = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
      return `${kp.publicKey.algorithm.name}/${kp.publicKey.type}`;
    });

    await rec('X25519 deriveBits (own pair)', async () => {
      const a = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
      const b = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
      const bits = await subtle.deriveBits(
        { name: 'X25519', public: b.publicKey },
        a.privateKey,
        256,
      );
      return `derived ${bits.byteLength} bytes`;
    });

    await rec('Ed25519 generateKey', async () => {
      const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      return `${kp.publicKey.algorithm.name}`;
    });

    await rec('Ed25519 sign', async () => {
      const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      const sig = await subtle.sign({ name: 'Ed25519' }, kp.privateKey, new Uint8Array([1, 2, 3]));
      return `sig ${sig.byteLength} bytes`;
    });

    await rec('ECDH P-256 generateKey', async () => {
      const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      return kp.publicKey.algorithm.namedCurve;
    });

    await rec('HKDF deriveBits', async () => {
      const key = await subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']);
      const bits = await subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new Uint8Array(0) },
        key,
        256,
      );
      return `${bits.byteLength} bytes`;
    });

    await rec('AES-GCM roundtrip', async () => {
      const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array([1, 2, 3, 4]));
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      return `pt ${pt.byteLength} bytes`;
    });

    // Is there a WASM path available (libsignal often ships as WASM)?
    await rec('WebAssembly.instantiate', async () => {
      const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return instance ? 'ok' : 'no instance';
    });

    return results;
  });

  out.failures = out.probes.filter((p) => !p.ok);
  console.log(
    out.probes
      .map((p) => `${p.ok ? 'OK  ' : 'FAIL'} ${p.name.padEnd(32)} ${JSON.stringify(p.detail).slice(0, 90)}`)
      .join('\n'),
  );

  await browser.disconnect();
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  await server.writeLogs(`${resultsDir}23-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '23-crypto-x25519.json', out);
  console.log(`\nsaved ${path}`);
}
