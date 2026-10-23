#!/usr/bin/env node
/**
 * Fallback-path baseline: Baileys 6.7.24.
 *
 * Proves the chosen production transport works on this machine and records
 * its footprint with a live, unpaired socket (QR shown) for the G6
 * comparison. No phone needed: it exits before pairing.
 *
 * QR payload is printed to the terminal only. It is never written to disk.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import QRCode from 'qrcode-terminal';

const out = { script: '15-baileys-baseline' };

const authDir = await mkdtemp(`${tmpdir()}/baileys-`);
out.authDir = '(ephemeral tmp, deleted on exit)';

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
  return Math.round([...tree].reduce((s, p) => s + (byPid.get(p)?.rssKb ?? 0), 0) / 1024);
}

const samples = [];
const sampler = setInterval(async () => {
  samples.push({ at: Date.now(), rssMb: await rssTree(process.pid) });
}, 3000);

let socket;
try {
  const baileys = await import('@whiskeysockets/baileys');
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } =
    baileys;

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const t0 = Date.now();
  socket = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['ObscuraWA spike', 'Chrome', '143.0.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  socket.ev.on('creds.update', saveCreds);

  const qr = await new Promise((resolve) => {
    let printed = false;
    const timeout = setTimeout(() => resolve({ timeout: true }), 45_000);
    socket.ev.on('connection.update', (u) => {
      if (u.qr && !printed) {
        printed = true;
        out.qrReceivedMs = Date.now() - t0;
        out.qrLength = u.qr.length;
        console.log(`\nQR received in ${out.qrReceivedMs} ms (length ${u.qr.length})\n`);
        QRCode.generate(u.qr, { small: true });
        // Give the socket a moment in the "connecting" state for measurement,
        // then stop: pairing is a separate, human step.
        setTimeout(() => { clearTimeout(timeout); resolve({ qr: true, state: u }); }, 4000);
      }
      if (u.connection === 'open') { clearTimeout(timeout); resolve({ open: true }); }
      if (u.connection === 'close' && u.disconnectReason) {
        clearTimeout(timeout);
        resolve({ closed: u.disconnectReason });
      }
    });
  });

  out.qrOrState = qr.qr
    ? 'qr-shown'
    : qr.open
      ? 'connected'
      : typeof qr.closed === 'number'
        ? `closed:${qr.closed}`
        : JSON.stringify(qr);
  out.connected = Boolean(qr.open);
} catch (err) {
  out.error = String(err.stack || err);
  console.error('FAILED:', out.error);
} finally {
  clearInterval(sampler);
  await new Promise((r) => setTimeout(r, 200));
  try {
    socket?.end?.(undefined);
    socket?.logout?.();
  } catch { /* not paired yet */ }
  await rm(authDir, { recursive: true, force: true });
  const peak = samples.reduce((m, s) => Math.max(m, s.rssMb), 0);
  out.rssSamplesMb = samples.map((s) => s.rssMb);
  out.peakRssMb = peak;
  out.finalRssMb = samples.at(-1)?.rssMb ?? null;
  const { writeFile, mkdir } = await import('node:fs/promises');
  const resultsDir = new URL('../results/', import.meta.url).pathname;
  await mkdir(resultsDir, { recursive: true });
  const path = `${resultsDir}15-baileys-baseline.json`;
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `\nstate: ${out.qrOrState} | RSS samples: [${out.rssSamplesMb.join(', ')}] MB | peak ${peak} MB`,
  );
  console.log(`saved ${path}`);
}
