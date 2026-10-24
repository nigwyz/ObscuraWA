#!/usr/bin/env node
/**
 * 24 — correctness gate for the asymmetric WebCrypto polyfill.
 *
 * spike/lib/subtle-polyfill.js serves X25519/Ed25519 from @noble/curves and
 * delegates everything else to Obscura's native subtle. Before spending two
 * minutes on a WhatsApp boot, prove the six operations the Noise handshake
 * uses actually work: generate, export raw, import raw, derive both ways,
 * spki/pkcs8 roundtrip, and Ed25519 sign/verify.
 */
import { mkdir, readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { ObscuraServer, connectPuppeteer, freePort, saveResult } from './lib/obscura.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const nobleSource = await readFile(new URL('./lib/noble-bundle.js', import.meta.url), 'utf8');
const polyfillSource = await readFile(new URL('./lib/subtle-polyfill.js', import.meta.url), 'utf8');

const out = { script: '24-subtle-polyfill-gate', startedAt: new Date().toISOString(), checks: [] };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-24` });

try {
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(nobleSource);
  await page.evaluateOnNewDocument(polyfillSource);
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });

  out.checks = await page.evaluate(async () => {
    const subtle = crypto.subtle;
    const checks = [];
    const hex = (buf) =>
      Array.from(new Uint8Array(buf))
        .map((b) => ('0' + b.toString(16)).slice(-2))
        .join('');
    const same = (a, b) => {
      const x = new Uint8Array(a);
      const y = new Uint8Array(b);
      return x.length === y.length && x.every((v, i) => v === y[i]);
    };
    const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail ?? null });
    const expectThrow = async (name, fn) => {
      try {
        await fn();
        check(name, false, 'expected a throw, got success');
      } catch (e) {
        check(name, true, String((e && (e.name + ': ' + e.message)) || e));
      }
    };

    check('noble bundle', typeof __obscuraNoble === 'object' && !!__obscuraNoble.x25519 && !!__obscuraNoble.ed25519);
    check('subtle patched', subtle.__obscuraAsymPatched === true);

    // --- X25519 -----------------------------------------------------------
    const a = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const b = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    check('X25519 generateKey', a.privateKey.type === 'private' && a.publicKey.type === 'public');

    const aPub = await subtle.exportKey('raw', a.publicKey);
    const bPub = await subtle.exportKey('raw', b.publicKey);
    check('X25519 export raw', new Uint8Array(aPub).length === 32 && new Uint8Array(bPub).length === 32);

    const ab = await subtle.deriveBits({ name: 'X25519', public: b.publicKey }, a.privateKey, 256);
    const ba = await subtle.deriveBits({ name: 'X25519', public: a.publicKey }, b.privateKey, 256);
    check('X25519 DH agrees', same(ab, ba), hex(ab).slice(0, 16) + '…');

    const importedB = await subtle.importKey('raw', bPub, { name: 'X25519' }, true, []);
    const ab2 = await subtle.deriveBits({ name: 'X25519', public: importedB }, a.privateKey, 256);
    check('X25519 import raw + DH', same(ab, ab2));

    const spki = await subtle.exportKey('spki', a.publicKey);
    const importedSpki = await subtle.importKey('spki', spki, { name: 'X25519' }, true, []);
    check('X25519 spki roundtrip', same(await subtle.exportKey('raw', importedSpki), aPub), `${new Uint8Array(spki).length} B`);

    const pkcs8 = await subtle.exportKey('pkcs8', a.privateKey);
    const importedPkcs8 = await subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, true, ['deriveBits']);
    const ab3 = await subtle.deriveBits({ name: 'X25519', public: b.publicKey }, importedPkcs8, 256);
    check('X25519 pkcs8 roundtrip', same(ab, ab3), `${new Uint8Array(pkcs8).length} B`);

    // Older spelling still used by some libraries.
    const c = await subtle.generateKey({ name: 'ECDH', namedCurve: 'X25519' }, true, ['deriveBits']);
    const d = await subtle.generateKey({ name: 'ECDH', namedCurve: 'X25519' }, true, ['deriveBits']);
    const cd = await subtle.deriveBits({ name: 'ECDH', namedCurve: 'X25519', public: d.publicKey }, c.privateKey, 256);
    const dc = await subtle.deriveBits({ name: 'ECDH', namedCurve: 'X25519', public: c.publicKey }, d.privateKey, 256);
    check('X25519 via ECDH alias', same(cd, dc) && c.publicKey.algorithm.namedCurve === 'X25519');

    // --- Ed25519 ----------------------------------------------------------
    const ed = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const message = new TextEncoder().encode('obscura-noise-handshake');
    const sig = await subtle.sign({ name: 'Ed25519' }, ed.privateKey, message);
    const good = await subtle.verify({ name: 'Ed25519' }, ed.publicKey, sig, message);
    const bad = await subtle.verify({ name: 'Ed25519' }, ed.publicKey, sig, new TextEncoder().encode('tampered'));
    check('Ed25519 sign/verify', good === true && bad === false, `${new Uint8Array(sig).length} B signature`);

    const edSpki = await subtle.exportKey('spki', ed.publicKey);
    const edPub = await subtle.importKey('spki', edSpki, { name: 'Ed25519' }, true, ['verify']);
    check('Ed25519 spki roundtrip', (await subtle.verify({ name: 'Ed25519' }, edPub, sig, message)) === true);

    const edPkcs8 = await subtle.exportKey('pkcs8', ed.privateKey);
    const edPriv = await subtle.importKey('pkcs8', edPkcs8, { name: 'Ed25519' }, true, ['sign']);
    const sig2 = await subtle.sign({ name: 'Ed25519' }, edPriv, message);
    check('Ed25519 pkcs8 roundtrip', (await subtle.verify({ name: 'Ed25519' }, ed.publicKey, sig2, message)) === true);

    // --- delegation to native --------------------------------------------
    const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, new Uint8Array([1, 2, 3, 4]));
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, aes, ct);
    check('native AES-GCM delegated', pt.byteLength === 4 && new Uint8Array(pt)[0] === 1);

    const hkdfKey = await subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']);
    const okm = await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new Uint8Array(0) },
      hkdfKey,
      256,
    );
    check('native HKDF delegated', new Uint8Array(okm).length === 32);

    await expectThrow('unsupported algorithm still rejects', () =>
      subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt']),
    );

    return checks;
  });

  const failed = out.checks.filter((c) => !c.ok);
  console.log(
    out.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`).join('\n'),
  );
  out.passed = out.checks.length - failed.length;
  out.failed = failed.length;
  if (failed.length) process.exitCode = 1;

  await browser.disconnect();
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
  process.exitCode = 1;
} finally {
  await server.writeLogs(`${resultsDir}24-obscura.log`);
  await server.stop();
  const path = await saveResult(resultsDir, '24-subtle-polyfill-gate.json', out);
  console.log(`saved ${path}`);
}
