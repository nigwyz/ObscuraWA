#!/usr/bin/env node
/**
 * 37 — resolve the current build's WAWebSetFrontendHandlerApi chunk.
 *
 * The page document carries the tiered Bootloader rsrcMap but the current
 * build never hands the handler resource to the Bootloader. This script:
 *   1. captures the server document over raw CDP;
 *   2. extracts every JS URL from the document's Bootloader payloads;
 *   3. downloads them and finds the chunk defining the handler;
 *   4. caches the source at results/handler-chunk.js and metadata at
 *      results/handler-chunk.json for 33 to consume.
 *
 * The cached chunk is a build asset, not session material.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { ObscuraServer, freePort } from './lib/obscura.mjs';
import { connectCdp } from './lib/cdp-client.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
const storageDir = `${resultsDir}storage-37`;
await mkdir(resultsDir, { recursive: true });

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const out = { script: '37-resolve-handler-chunk', startedAt: new Date().toISOString() };
const port = await freePort();
const server = new ObscuraServer({ port, storageDir });
let cdp;

function parseDocument(html) {
  const scripts = [
    ...html.matchAll(
      /<script type="application\/json"[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/g,
    ),
  ];
  const urls = new Map();
  let build = null;
  const spin = html.match(/"__spin_r":(\d+)/);
  if (spin) build = spin[1];

  for (const script of scripts) {
    let payload;
    try {
      payload = JSON.parse(script[1]);
    } catch {
      continue;
    }
    const req = payload.require && payload.require[0];
    if (!req || req[0] !== 'Bootloader') continue;
    const map = req[3]?.[0]?.rsrcMap;
    if (!map) continue;
    for (const [hash, value] of Object.entries(map)) {
      if (value?.type !== 'js' || !value?.src) continue;
      urls.set(value.src, { hash, p: value.p || null });
    }
  }

  return { scripts: scripts.length, build, urls: [...urls.entries()].map(([url, meta]) => ({ url, ...meta })) };
}

async function downloadAll(entries) {
  const chunks = [];
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < entries.length) {
      const entry = entries[next++];
      try {
        const res = await fetch(entry.url, {
          headers: { 'User-Agent': UA, Referer: 'https://web.whatsapp.com/' },
        });
        if (!res.ok) continue;
        const text = await res.text();
        done++;
        const defines = new Map();
        const re = /__d\("([^"]+)",\[([^\]]*)\]/g;
        let match;
        while ((match = re.exec(text))) {
          const deps = [...match[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
          defines.set(match[1], deps);
        }
        chunks.push({ ...entry, text, defines });
      } catch {
        /* skip failed asset */
      }
    }
  }

  await Promise.all(Array.from({ length: 24 }, worker));
  return { chunks, done };
}

function selectClosure(chunks, root) {
  const byName = new Map();
  for (const chunk of chunks) {
    for (const name of chunk.defines.keys()) {
      if (!byName.has(name)) byName.set(name, chunk);
    }
  }
  const rootChunk = byName.get(root);
  if (!rootChunk) return null;

  const selected = new Map();
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const chunk = byName.get(name);
    if (!chunk) continue;
    selected.set(chunk.url, chunk);
    for (const dependency of chunk.defines.get(name) || []) {
      queue.push(dependency);
    }
  }
  return { rootChunk, selected: [...selected.values()] };
}

try {
  await server.start();
  cdp = await connectCdp(port);
  const { sessionId } = await cdp.createPage();
  await cdp.send('Network.enable', {}, sessionId);

  let docRequestId = null;
  cdp.on('Network.responseReceived', (params, sid) => {
    if (sid && sid !== sessionId) return;
    const response = params.response || {};
    if (
      params.type === 'Document' &&
      /^https:\/\/web\.whatsapp\.com\/?(?:[?#].*)?$/.test(response.url || '')
    ) {
      docRequestId = params.requestId;
    }
  });

  await cdp.navigate(sessionId, 'https://web.whatsapp.com/');

  const deadline = Date.now() + 30_000;
  let html = null;
  while (Date.now() < deadline && !html) {
    if (docRequestId) {
      html = await cdp
        .send('Network.getResponseBody', { requestId: docRequestId }, sessionId)
        .then((r) => (r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body))
        .catch(() => null);
    }
    if (!html) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!html) throw new Error('could not capture the document');

  out.docBytes = html.length;
  const parsed = parseDocument(html);
  out.build = parsed.build;
  out.scripts = parsed.scripts;
  out.jsResources = parsed.urls.length;
  if (!parsed.urls.length) throw new Error('no Bootloader rsrcMap JS resources');

  const { chunks, done } = await downloadAll(parsed.urls);
  out.downloaded = done;

  let ordered;
  if (process.env.HANDLER_CLOSURE === '1') {
    const closure = selectClosure(chunks, 'WAWebSetFrontendHandlerApi');
    if (!closure) throw new Error('handler module not found in rsrcMap resources');
    out.mode = 'closure';
    const rootUrl = closure.rootChunk.url;
    ordered = [...closure.selected].sort((a, b) => {
      const aRoot = a.url === rootUrl ? 1 : 0;
      const bRoot = b.url === rootUrl ? 1 : 0;
      return aRoot - bRoot;
    });
  } else {
    const root = chunks.find((chunk) => chunk.defines.has('WAWebSetFrontendHandlerApi'));
    if (!root) throw new Error('handler module not found in rsrcMap resources');
    const largest = chunks
      .filter((chunk) => chunk !== root)
      .sort((a, b) => b.text.length - a.text.length)[0];
    if (!largest) throw new Error('no dependency bundle found');
    out.mode = 'handler+largest';
    ordered = [largest, root];
  }

  const combined = ordered.map((chunk) => chunk.text).join('\n');

  const rootChunk = ordered[ordered.length - 1];
  out.hash = rootChunk.hash;
  out.p = rootChunk.p;
  out.url = rootChunk.url;
  out.bytes = combined.length;
  out.modules = ordered.reduce((total, chunk) => total + chunk.defines.size, 0);
  out.chunks = ordered.map((chunk) => ({
    hash: chunk.hash,
    url: chunk.url,
    bytes: chunk.text.length,
    modules: chunk.defines.size,
  }));

  await writeFile(`${resultsDir}handler-chunk.js`, combined);
  await writeFile(
    `${resultsDir}handler-chunk.json`,
    `${JSON.stringify(
      {
        build: out.build,
        hash: out.hash,
        p: out.p,
        url: out.url,
        bytes: out.bytes,
        modules: out.modules,
        chunks: out.chunks,
        fetchedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    [
      `doc: ${out.docBytes} bytes, build ${out.build ?? 'unknown'}`,
      `rsrcMap JS: ${out.jsResources}, downloaded ${out.downloaded}`,
      `handler: ${out.hash} ${out.bytes} bytes`,
      `closure: ${out.chunks.length} chunks, ${out.modules} modules`,
      ...out.chunks.map(
        (chunk) => `  ${chunk.hash} ${chunk.bytes} bytes (${chunk.modules} modules)`,
      ),
      `cached: ${resultsDir}handler-chunk.js`,
    ].join('\n'),
  );
} catch (e) {
  out.error = String(e.stack || e);
  console.error('FAILED:', out.error);
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  await server.stop();
  await writeFile(`${resultsDir}37-resolve-handler-chunk.json`, JSON.stringify(out, null, 2)).catch(
    () => {},
  );
  console.log(`saved ${resultsDir}37-resolve-handler-chunk.json`);
}
