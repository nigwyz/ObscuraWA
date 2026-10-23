#!/usr/bin/env node
/**
 * G6 baseline — whatsapp-web.js on Chromium, booting web.whatsapp.com to QR.
 *
 * This is the reference path: it shows what a successful WhatsApp Web boot
 * looks like (Debug.VERSION, QR canvas) and records the memory cost of the
 * same workload on Chromium for comparison with Obscura.
 *
 * No phone needed: it stops at the QR and exits.
 */
import { mkdir, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });

const out = { script: '07-chromium-baseline', samples: [] };

const { default: WhatsApp } = await import('whatsapp-web.js');
const { Client, LocalAuth } = WhatsApp;
const qrcode = (await import('qrcode-terminal')).default;

async function rssTree(rootPid) {
  const { readdir, readFile } = await import('node:fs/promises');
  const entries = await readdir('/proc');
  const byPid = new Map();
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/^VmRSS:\s+(\d+) kB/m);
      byPid.set(pid, { ppid, rssKb: m ? Number(m[1]) : 0 });
    } catch { /* gone */ }
  }
  const tree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, i] of byPid) {
      if (!tree.has(pid) && tree.has(i.ppid)) { tree.add(pid); grew = true; }
    }
  }
  return [...tree].reduce((s, p) => s + (byPid.get(p)?.rssKb ?? 0), 0);
}

const authDir = `${resultsDir}chromium-auth`;
const t0 = Date.now();
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: authDir }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
  // Use the live WhatsApp Web build, not the cached snapshot, so the Chromium
  // baseline is measuring the same app the Obscura runs were trying to load.
  webVersionCache: { type: 'none' },
});

const state = { qr: false, ready: false, errors: [], console: [] };
client.on('qr', (qr) => {
  if (!state.qr) {
    state.qr = true;
    out.qrMs = Date.now() - t0;
    console.log(`\n[chromium] QR in ${out.qrMs} ms\n`);
    qrcode.generate(qr, { small: true });
  }
});
client.on('ready', () => {
  state.ready = true;
  out.readyMs = Date.now() - t0;
  console.log(`\n[chromium] READY in ${out.readyMs} ms`);
});
client.on('auth_failure', (m) => state.errors.push(`auth_failure: ${m}`));
client.on('disconnected', (m) => state.errors.push(`disconnected: ${m}`));

const sampler = setInterval(async () => {
  const pid = client.pupBrowser?.process?.()?.pid;
  const total = await rssTree(process.pid);
  out.samples.push({
    at: Date.now() - t0,
    rssMb: Math.round(total / 1024),
    chromePidMb: pid ? Math.round((await rssTree(pid)) / 1024) : null,
  });
}, 3000);

try {
  await client.initialize();
  // Give it a little longer after QR so the boot cost is captured.
  await new Promise((r) => setTimeout(r, 8000));
  out.info = client.info
    ? { wid: client.info.wid?._serialized, pushname: client.info.pushname }
    : null;
  // Capture what a successful boot looks like, for the ADR comparison.
  out.pageSnapshot = await client.pupPage
    .evaluate(() => ({
      debugVersion: window.Debug?.VERSION ?? null,
      require: typeof window.require,
      hasQrCanvas: Boolean(document.querySelector('canvas')),
      hasPaneSide: Boolean(document.querySelector('#pane-side')),
      bodyLength: document.body?.innerHTML?.length ?? -1,
    }))
    .catch((e) => ({ error: String(e.message || e) }));
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  clearInterval(sampler);
  out.peakRssMb = out.samples.reduce((m, s) => Math.max(m, s.rssMb), 0);
  out.chromePeakMb = out.samples.reduce((m, s) => Math.max(m, s.chromePidMb ?? 0), 0);
  out.state = { qr: state.qr, ready: state.ready, errors: state.errors };
  await client.destroy().catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  await rm(authDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(resultsDir, { recursive: true });
  const path = `${resultsDir}07-chromium-baseline.json`;
  await (await import('node:fs/promises')).writeFile(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `\nqr=${state.qr} ready=${state.ready} | node+chrome peak RSS ${out.peakRssMb} MB (chrome alone ${out.chromePeakMb} MB)`,
  );
  console.log(`saved ${path}`);
  setTimeout(() => process.exit(0), 1000);
}
