#!/usr/bin/env node
/**
 * 38 — verify disk-backed IndexedDB across an engine restart.
 *
 * Uses example.com as a normal secure origin, writes one structured value,
 * waits for the periodic snapshot flush, restarts the engine with the same
 * --storage-dir, and reads the value back.
 *
 * Run against a patched engine:
 *   OBSCURA_BIN=vendor/obscura/target/release/obscura node spike/38-idb-persistence.mjs
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { ObscuraServer, freePort } from './lib/obscura.mjs';
import { connectCdp } from './lib/cdp-client.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
const storageDir = `${resultsDir}storage-38`;
const DB_NAME = 'obscura-persist';
const STORE = 'kv';
const KEY = 'roundtrip';

const out = { script: '38-idb-persistence', startedAt: new Date().toISOString() };

const writeExpr = `new Promise((resolve, reject) => {
  const request = indexedDB.open(${JSON.stringify(DB_NAME)}, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(${JSON.stringify(STORE)});
  request.onerror = () => reject(request.error || new Error('open failed'));
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction(${JSON.stringify(STORE)}, 'readwrite');
    tx.objectStore(${JSON.stringify(STORE)}).put({ hello: 'world', n: 42 }, ${JSON.stringify(KEY)});
    tx.oncomplete = () => { db.close(); resolve({ ok: true }); };
    tx.onerror = () => reject(tx.error || new Error('put failed'));
  };
})`;

const readExpr = `new Promise((resolve) => {
  const request = indexedDB.open(${JSON.stringify(DB_NAME)}, 1);
  request.onupgradeneeded = () => {
    try { request.result.createObjectStore(${JSON.stringify(STORE)}); } catch (e) { /* exists */ }
  };
  request.onerror = () => resolve({ error: 'open failed' });
  request.onsuccess = () => {
    const db = request.result;
    try {
      if (!db.objectStoreNames.contains(${JSON.stringify(STORE)})) {
        db.close();
        resolve(null);
        return;
      }
      const tx = db.transaction(${JSON.stringify(STORE)}, 'readonly');
      const get = tx.objectStore(${JSON.stringify(STORE)}).get(${JSON.stringify(KEY)});
      get.onsuccess = () => { const value = get.result ?? null; db.close(); resolve(value); };
      get.onerror = () => { db.close(); resolve({ error: 'get failed' }); };
    } catch (e) {
      db.close();
      resolve({ error: String(e.message || e) });
    }
  };
})`;

const servers = [];
const clients = [];

async function boot(label) {
  const port = await freePort();
  const server = new ObscuraServer({ port, storageDir });
  servers.push(server);
  await server.start();
  const cdp = await connectCdp(port);
  clients.push(cdp);
  const { sessionId } = await cdp.createPage();
  await cdp.navigate(sessionId, 'https://example.com/');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = await cdp
      .evaluate(sessionId, 'document.readyState')
      .catch(() => null);
    if (ready === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  out[label] = { port, sessionId };
  return { server, cdp, sessionId };
}

try {
  await mkdir(resultsDir, { recursive: true });
  await rm(storageDir, { recursive: true, force: true });

  const first = await boot('first');
  out.write = await first.cdp.evaluate(first.sessionId, writeExpr);
  // The patched storage flushes every 2s; give it one interval plus margin.
  await new Promise((resolve) => setTimeout(resolve, 3500));
  first.cdp.close();
  await first.server.stop();
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const snapshotPath = `${storageDir}/indexeddb.json`;
  out.snapshotBytes = (await readFile(snapshotPath).catch(() => Buffer.alloc(0))).length;
  out.snapshotExists = out.snapshotBytes > 0;
  if (out.snapshotExists) {
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    out.snapshotDatabases = snapshot.databases?.map((db) => `${db.origin}/${db.name}`) ?? [];
  }

  const second = await boot('second');
  out.read = await second.cdp.evaluate(second.sessionId, readExpr);
  second.cdp.close();
  await second.server.stop();

  out.ok =
    out.snapshotExists &&
    out.read &&
    out.read.hello === 'world' &&
    out.read.n === 42;
  console.log(
    [
      `write: ${JSON.stringify(out.write)}`,
      `snapshot: ${out.snapshotBytes} bytes, exists=${out.snapshotExists}`,
      `databases: ${JSON.stringify(out.snapshotDatabases ?? [])}`,
      `read after restart: ${JSON.stringify(out.read)}`,
      `result: ${out.ok ? 'PASS' : 'FAIL'}`,
    ].join('\n'),
  );
  if (!out.ok) process.exitCode = 1;
} catch (error) {
  out.error = String(error.stack || error);
  console.error('FAILED:', out.error);
  process.exitCode = 1;
} finally {
  for (const client of clients) {
    try { client.close(); } catch { /* already closed */ }
  }
  for (const server of servers) {
    await server.stop().catch(() => {});
  }
  await writeFile(`${resultsDir}38-idb-persistence.json`, JSON.stringify(out, null, 2)).catch(
    () => {},
  );
  console.log(`saved ${resultsDir}38-idb-persistence.json`);
}
