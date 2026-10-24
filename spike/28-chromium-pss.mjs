#!/usr/bin/env node
/**
 * 28 — Chrome PSS baseline.
 *
 * Same workload as 07 (whatsapp-web.js, headless, live web version, stop at
 * QR + 8 s) but measures PSS from smaps_rollup. Summed RSS double-counts
 * shared libraries across Chrome's process tree; PSS does not.
 */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { saveResult } from './lib/obscura.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });
const out = { script: '28-chromium-pss', samples: [] };

const { default: WhatsApp } = await import('whatsapp-web.js');
const { Client, LocalAuth } = WhatsApp;

async function memTree(rootPid) {
  const entries = await readdir('/proc');
  const byPid = new Map();
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const rss = status.match(/^VmRSS:\s+(\d+) kB/m);
      const rollup = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
      const pss = rollup.match(/^Pss:\s+(\d+) kB/m);
      byPid.set(pid, {
        ppid,
        rssKb: rss ? Number(rss[1]) : 0,
        pssKb: pss ? Number(pss[1]) : 0,
      });
    } catch {
      /* gone */
    }
  }
  const tree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, i] of byPid) {
      if (!tree.has(pid) && tree.has(i.ppid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  let rssKb = 0;
  let pssKb = 0;
  for (const pid of tree) {
    rssKb += byPid.get(pid)?.rssKb ?? 0;
    pssKb += byPid.get(pid)?.pssKb ?? 0;
  }
  return { rssMb: Math.round(rssKb / 1024), pssMb: Math.round(pssKb / 1024) };
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: `${resultsDir}chromium-auth` }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
  webVersionCache: { type: 'none' },
});

let qrMs = null;
client.on('qr', () => {
  if (qrMs == null) qrMs = Date.now() - t0;
});
const errors = [];
client.on('auth_failure', (m) => errors.push(`auth_failure: ${m}`));
client.on('disconnected', (m) => errors.push(`disconnected: ${m}`));

const t0 = Date.now();
const sampler = setInterval(async () => {
  try {
    const pid = client.pupBrowser?.process?.()?.pid;
    const total = await memTree(process.pid);
    const chrome = pid ? await memTree(pid) : null;
    const node = await memTree(process.pid); // includes chrome; derive below
    out.samples.push({
      at: Date.now() - t0,
      totalRssMb: total.rssMb,
      totalPssMb: total.pssMb,
      chromeRssMb: chrome?.rssMb ?? null,
      chromePssMb: chrome?.pssMb ?? null,
      nodePssMb: chrome ? total.pssMb - chrome.pssMb : total.pssMb,
      nodeRssMb: chrome ? total.rssMb - chrome.rssMb : total.rssMb,
    });
  } catch {
    /* process tree raced */
  }
}, 2000);

try {
  await client.initialize();
  await new Promise((r) => setTimeout(r, 8000));
  out.qrMs = qrMs;
  out.errors = errors;
  out.peakTotalRssMb = Math.max(...out.samples.map((s) => s.totalRssMb), 0);
  out.peakTotalPssMb = Math.max(...out.samples.map((s) => s.totalPssMb), 0);
  out.peakChromePssMb = Math.max(...out.samples.map((s) => s.chromePssMb ?? 0), 0);
  out.peakNodePssMb = Math.max(...out.samples.map((s) => s.nodePssMb ?? 0), 0);
  console.log(
    `QR ${out.qrMs} ms | total PSS ${out.peakTotalPssMb} MB (RSS ${out.peakTotalRssMb} MB) | chrome PSS ${out.peakChromePssMb} MB | node PSS ${out.peakNodePssMb} MB`,
  );
} catch (e) {
  out.error = String(e.stack || e);
  console.error(out.error);
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  await client.destroy().catch(() => {});
  await saveResult(resultsDir, '28-chromium-pss.json', out);
}
