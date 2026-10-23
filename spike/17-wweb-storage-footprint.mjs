#!/usr/bin/env node
/**
 * Where does a linked WhatsApp Web session live on disk?
 *
 * This is the load-bearing claim behind the G4/G5 verdict: if WhatsApp keeps
 * its Signal/app state in IndexedDB, then any engine that does not persist
 * IndexedDB cannot hold a session across a restart.
 *
 * Boots whatsapp-web.js on Chromium (the known-good reference), stops at the
 * QR, then reports which profile directories Chrome actually wrote. No phone
 * needed: it inspects the on-disk layout an unpaired session already creates.
 */
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });
const authDir = `${resultsDir}storage-footprint-chromium`;

await rm(authDir, { recursive: true, force: true });

const { default: WhatsApp } = await import('whatsapp-web.js');
const { Client, LocalAuth } = WhatsApp;

const out = { script: '17-wweb-storage-footprint', authDir: '(repo results dir)' };
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: authDir }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
  webVersionCache: { type: 'none' },
});

const qr = new Promise((resolve) => {
  client.once('qr', () => resolve(true));
  setTimeout(() => resolve(false), 90_000);
});

try {
  await client.initialize();
  out.reachedQr = await qr;

  // Give Chrome a moment to flush the profile, then snapshot without a clean
  // shutdown - an unclean stop is the state that matters for crash recovery.
  await new Promise((r) => setTimeout(r, 5000));
  out.layout = await walk(authDir);
  out.totalBytes = sumBytes(out.layout);
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  try {
    client.pupBrowser?.process()?.kill('SIGKILL');
  } catch {
    /* browser already gone */
  }
  await client.destroy().catch(() => {});
  const path = `${resultsDir}17-wweb-storage-footprint.json`;
  await (await import('node:fs/promises')).writeFile(
    path,
    `${JSON.stringify(out, null, 2)}\n`,
  );
  report(out.layout, out.totalBytes);
  console.log(`\\nsaved ${path}`);
  await rm(authDir, { recursive: true, force: true }).catch(() => {});
}

/** Directories and files Chrome wrote, with sizes. Depth-limited to stay readable. */
async function walk(dir, depth = 0) {
  if (depth > 3) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const result = {};
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walk(p, depth + 1);
      result[entry.name] = sub ?? {};
    } else {
      try {
        result[entry.name] = (await stat(p)).size;
      } catch {
        result[entry.name] = 'gone';
      }
    }
  }
  return result;
}

function sumBytes(tree) {
  if (!tree) return 0;
  let total = 0;
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'number') total += value;
    else if (value && typeof value === 'object') total += sumBytes(value);
  }
  return total;
}

function report(tree, total) {
  const interesting = ['IndexedDB', 'Local Storage', 'Session Storage', 'Cookies', 'databases'];
  console.log(`\nprofile bytes on disk (unpaired, killed): ${Math.round(total / 1024)} KB`);
  const find = (t, name, path = '') => {
    if (!t || typeof t !== 'object') return [];
    const hits = [];
    for (const [k, v] of Object.entries(t)) {
      const p = path ? `${path}/${k}` : k;
      if (k === name) hits.push({ path: p, subtree: v });
      if (v && typeof v === 'object') hits.push(...find(v, name, p));
    }
    return hits;
  };
  for (const name of interesting) {
    const hits = find(tree, name);
    if (!hits.length) continue;
    for (const hit of hits) {
      const bytes = sumBytes(hit.subtree);
      console.log(`  ${hit.path}  ->  ${Math.round(bytes / 1024)} KB`);
    }
  }
}
