/**
 * Obscura server lifecycle + measurement helpers for the spike.
 *
 * One `ObscuraServer` == one `obscura serve` process == one storage dir. That
 * mirrors the intended production topology: storage (cookies, localStorage) is
 * per-process, so per-merchant isolation means per-process.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { readdir } from 'node:fs/promises';

export const OBSCURA_BIN =
  process.env.OBSCURA_BIN ?? '/home/hp/.local/share/obscurawa/bin/obscura';

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Sum VmRSS (kB) of a pid and every descendant, plus a per-process breakdown. */
export async function processTreeRss(rootPid) {
  const entries = await readdir('/proc');
  const pids = entries.filter((e) => /^\d+$/.test(e)).map(Number);
  const byPid = new Map();
  for (const pid of pids) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // comm can contain spaces/parens; ppid is field 4 after the comm token.
      const commEnd = stat.lastIndexOf(')');
      const rest = stat.slice(commEnd + 2).split(' ');
      const ppid = Number(rest[1]);
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/^VmRSS:\s+(\d+) kB/m);
      const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      byPid.set(pid, {
        ppid,
        rssKb: m ? Number(m[1]) : 0,
        cmd: cmd.replaceAll('\0', ' ').trim().split(/\s+/).slice(0, 3).join(' '),
      });
    } catch {
      /* process vanished */
    }
  }
  const tree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, info] of byPid) {
      if (!tree.has(pid) && tree.has(info.ppid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  const members = [...tree]
    .map((pid) => ({ pid, ...(byPid.get(pid) ?? { rssKb: 0, cmd: '?' }) }))
    .filter((x) => x.rssKb > 0);
  const totalKb = members.reduce((sum, x) => sum + x.rssKb, 0);
  return { totalKb, totalMb: Math.round(totalKb / 1024), members };
}

export class ObscuraServer {
  /**
   * @param {object} opts
   * @param {number} opts.port
   * @param {string} opts.storageDir
   * @param {string} [opts.logFile]
   * @param {string[]} [opts.extraArgs]
   */
  constructor({ port, storageDir, logFile, extraArgs = [], globalArgs = [] }) {
    this.port = port;
    this.storageDir = storageDir;
    this.logFile = logFile;
    this.extraArgs = extraArgs;
    this.globalArgs = globalArgs;
    this.child = null;
    this.logChunks = [];
    this.wsEndpoint = `ws://127.0.0.1:${this.port}`;
  }

  async start({ timeoutMs = 60_000 } = {}) {
    await mkdir(this.storageDir, { recursive: true });
    const readyFile = `${this.storageDir}/.ready-${randomBytes(4).toString('hex')}`;
    const args = [
      ...this.globalArgs,
      'serve',
      '--port',
      String(this.port),
      '--host',
      '127.0.0.1',
      '--storage-dir',
      this.storageDir,
      '--ready-file',
      readyFile,
      ...this.extraArgs,
    ];
    this.child = spawn(OBSCURA_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (chunk) => {
      const text = chunk.toString();
      this.logChunks.push(text);
      if (process.env.SPIKE_VERBOSE) process.stderr.write(`[obscura] ${text}`);
    };
    this.child.stdout.on('data', onData);
    this.child.stderr.on('data', onData);
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal, at: Date.now() };
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null || this.child.signalCode) {
        throw new Error(
          `obscura exited during startup (${this.child.exitCode}/${this.child.signalCode}): ${this.logChunks.join('')}`,
        );
      }
      try {
        const raw = await readFile(readyFile, 'utf8');
        this.readyInfo = raw.trim();
        await rm(readyFile, { force: true });
        return this;
      } catch {
        await sleep(150);
      }
    }
    throw new Error(`obscura did not become ready within ${timeoutMs} ms`);
  }

  async stop({ signal = 'SIGTERM', waitMs = 15_000 } = {}) {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill(signal);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null || this.child.signalCode) return;
      await sleep(100);
    }
    this.child.kill('SIGKILL');
  }

  get logs() {
    return this.logChunks.join('');
  }

  async writeLogs(path) {
    if (!this.logs) return;
    await writeFile(path, this.logs);
  }
}

/**
 * Connect puppeteer-core to a running Obscura, trying the documented
 * endpoint shapes. Returns { browser, endpoint, attempts }.
 */
export async function connectPuppeteer(port, puppeteer) {
  const attempts = [];
  const candidates = [
    `ws://127.0.0.1:${port}`,
    `ws://127.0.0.1:${port}/devtools/browser`,
  ];
  let version = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    version = await res.json();
    if (version.webSocketDebuggerUrl) {
      candidates.unshift(version.webSocketDebuggerUrl);
    }
  } catch {
    /* /json discovery is optional */
  }
  for (const endpoint of candidates) {
    try {
      const browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
      return { browser, endpoint, attempts, version };
    } catch (err) {
      attempts.push({ endpoint, error: String(err.message || err) });
    }
  }
  throw new Error(`could not connect over CDP: ${JSON.stringify(attempts)}`);
}

/** Save a JSON artifact under results/ and also echo a short summary. */
export async function saveResult(resultsDir, name, data) {
  await mkdir(resultsDir, { recursive: true });
  const path = `${resultsDir}/${name}`;
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}

export function table(rows, columns) {
  if (!rows.length) return '(no rows)';
  const cols = columns ?? Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)),
  );
  const line = (cells) =>
    cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ');
  return [
    line(cols),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(cols.map((c) => r[c]))),
  ].join('\n');
}
