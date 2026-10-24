import { mkdir, writeFile } from 'node:fs/promises';
import { ObscuraServer, freePort } from './lib/obscura.mjs';
import { connectCdp } from './lib/cdp-client.mjs';

const resultsDir = new URL('../results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });
const port = await freePort();
const server = new ObscuraServer({ port, storageDir: `${resultsDir}storage-31` });
try {
  await server.start();
  const cdp = await connectCdp(port);
  const { sessionId } = await cdp.createPage();
  await cdp.navigate(sessionId, 'https://example.com/');
  let title = null;
  for (let i = 0; i < 40; i++) {
    title = await cdp.evaluate(sessionId, 'document.title').catch(() => null);
    if (title) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const png = await cdp.screenshot(sessionId);
  await writeFile('/tmp/cdp-smoke.png', png);
  console.log('title:', title, 'png bytes:', png.length, 'heap:', JSON.stringify(await cdp.heapUsage(sessionId)));
  cdp.close();
} catch (e) {
  console.error('FAILED:', String(e.stack || e));
  process.exitCode = 1;
} finally {
  await server.stop();
}
