#!/usr/bin/env node
/**
 * G4/G5 — does session state survive a restart?
 *
 * WhatsApp Web keeps its Signal keys and app state in IndexedDB, and uses
 * localStorage for flags. Obscura documents `--storage-dir` as cookies +
 * localStorage only, with IndexedDB in memory. This measures that directly,
 * for a clean shutdown and for a hard kill.
 *
 * No phone needed: it proves the persistence mechanism itself, which is the
 * hard part of G4/G5.
 */
import { mkdir, rm } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import {
  ObscuraServer,
  connectPuppeteer,
  freePort,
  saveResult,
} from './lib/obscura.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const storageDir = `${resultsDir}storage-persist`;
const ORIGIN = 'https://example.com';
const out = { script: '14-persistence', storageDir, origin: ORIGIN, phases: {} };

const writeScript = `
  (async () => {
    localStorage.setItem('ls_marker', 'ls-' + Date.now());
    document.cookie = 'ck_marker=cookie1; path=/; max-age=86400';
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('spike_store', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ bytes: new Uint8Array([1,2,3,4]), at: Date.now() }, 'marker');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    return { ls: localStorage.getItem('ls_marker'), idb: 'written', cookie: document.cookie };
  })()
`;

const readScript = `
  (async () => {
    const out = { ls: localStorage.getItem('ls_marker'), cookie: document.cookie };
    out.idb = await new Promise((resolve) => {
      const req = indexedDB.open('spike_store', 1);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) { db.close(); return resolve('db-present-but-no-store'); }
        const tx = db.transaction('kv', 'readonly');
        const get = tx.objectStore('kv').get('marker');
        get.onsuccess = () => {
          const v = get.result;
          db.close();
          resolve(v ? { bytes: v.bytes instanceof Uint8Array ? Array.from(v.bytes) : String(v.bytes), at: v.at } : 'missing');
        };
        get.onerror = () => { db.close(); resolve('read-error'); };
      };
      req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
      req.onerror = () => resolve('open-error: ' + req.error);
    });
    return out;
  })()
`;

async function session(write) {
  const port = await freePort();
  const server = new ObscuraServer({ port, storageDir });
  await server.start();
  const { browser } = await connectPuppeteer(port, puppeteer);
  const page = await browser.newPage();
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const value = await page.evaluate(write ? writeScript : readScript);
  await browser.disconnect().catch(() => {});
  return { server, value };
}

try {
  await rm(storageDir, { recursive: true, force: true });

  // Phase 1: write
  const p1 = await session(true);
  out.phases.write = p1.value;
  await p1.server.stop(); // clean SIGTERM, docs say profile is flushed on exit
  out.phases.cleanStop = { exited: p1.server.exited ?? null };

  // Phase 2: read after clean restart
  const p2 = await session(false);
  out.phases.readAfterCleanRestart = p2.value;
  await p2.server.stop();

  // Phase 3: hard kill. Write, trigger a navigation so the profile is flushed
  // (docs: state is written after each navigation), then SIGKILL.
  const port = await freePort();
  const killer = new ObscuraServer({ port, storageDir });
  await killer.start();
  const { browser: kb } = await connectPuppeteer(port, puppeteer);
  const kp = await kb.newPage();
  await kp.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  out.phases.rewriteBeforeKill = await kp.evaluate(writeScript);
  await kp.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await kb.disconnect().catch(() => {});
  killer.child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 2000));
  out.phases.kill9 = { signal: killer.exited?.signal ?? 'SIGKILL' };

  const p4 = await session(false);
  out.phases.readAfterKill9 = p4.value;
  await p4.server.stop();

  const verdict = (r) => ({
    localStorage: Boolean(r?.ls),
    indexedDB: Boolean(r?.idb && typeof r.idb === 'object'),
    cookie: Boolean(r?.cookie && String(r.cookie).includes('ck_marker')),
    raw: r,
  });
  out.summary = {
    cleanRestart: verdict(out.phases.readAfterCleanRestart),
    kill9Restart: verdict(out.phases.readAfterKill9),
  };

  const s = out.summary;
  const idbSurvives = s.cleanRestart.indexedDB && s.kill9Restart.indexedDB;
  out.G4_pass = Boolean(s.cleanRestart.localStorage && s.cleanRestart.indexedDB && s.cleanRestart.cookie);
  out.G5_pass = Boolean(s.kill9Restart.localStorage && s.kill9Restart.indexedDB && s.kill9Restart.cookie);
  out.idbSurvives = idbSurvives;

  console.log(
    [
      'phase write                : ' + JSON.stringify(out.phases.write),
      'after clean restart        : ' + JSON.stringify(out.phases.readAfterCleanRestart),
      'after kill -9              : ' + JSON.stringify(out.phases.readAfterKill9),
      '',
      `localStorage survives : ${s.cleanRestart.localStorage} (clean) / ${s.kill9Restart.localStorage} (kill -9)`,
      `IndexedDB survives     : ${s.cleanRestart.indexedDB} (clean) / ${s.kill9Restart.indexedDB} (kill -9)`,
      `cookies survive        : ${s.cleanRestart.cookie} (clean) / ${s.kill9Restart.cookie} (kill -9)`,
      '',
      `G4 clean restart : ${out.G4_pass ? 'PASS' : 'FAIL'}`,
      `G5 crash recover : ${out.G5_pass ? 'PASS' : 'FAIL'}`,
    ].join('\n'),
  );
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  const path = await saveResult(resultsDir, '14-persistence.json', out);
  console.log(`\nsaved ${path}`);
}
