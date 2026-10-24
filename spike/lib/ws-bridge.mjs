/**
 * WebSocket bridge: gives an Obscura page a real socket.
 *
 * Obscura's `WebSocket` is a stub (`send(data) { /* drop *\/ }` in
 * crates/obscura-js/js/bootstrap.js). A page cannot open a socket itself, but
 * the host can — and CDP already gives us a channel between them.
 *
 * Design constraint learned in spike/10 and spike/11: CDP commands are
 * serialized per session, so the host must never initiate a command while the
 * page is waiting on one. Everything here is therefore page-driven:
 *
 *   page -> host   window.__obscuraWsSend(id, base64)     (exposeFunction)
 *   host -> page   page polls window.__obscuraWsPoll(id)  (exposeFunction)
 *
 * No host-initiated CDP calls, so no deadlock. The cost is one round trip per
 * poll, which is fine for pairing and message I/O and hopeless for bulk media.
 * This is a prototype bridge, not a production transport.
 */
import { WebSocket } from 'ws';

export async function installWsBridge(page, { maxQueue = 8192, verbose = false } = {}) {
  const sockets = new Map();
  const stats = { opened: 0, closed: 0, sent: 0, sentBytes: 0, received: 0, receivedBytes: 0, errors: 0 };

  const log = (...args) => {
    if (verbose) console.error('[ws-bridge]', ...args);
  };

  const push = (id, evt) => {
    const rec = sockets.get(id);
    if (!rec) return;
    if (rec.queue.length >= maxQueue) {
      rec.dropped++;
      if (rec.dropped === 1) log(`socket ${id} queue full, dropping`);
      return;
    }
    rec.queue.push(evt);
  };

  await page.exposeFunction('__obscuraWsOpen', (id, url, protocols) =>
    new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url, Array.isArray(protocols) && protocols.length ? protocols : undefined);
      } catch (e) {
        stats.errors++;
        reject(String((e && e.message) || e));
        return;
      }
      const rec = {
        ws,
        queue: [],
        dropped: 0,
        state: 'connecting',
        sent: 0,
        sentBytes: 0,
        received: 0,
        receivedBytes: 0,
        protocol: '',
      };
      sockets.set(id, rec);
      stats.opened++;
      ws.binaryType = 'nodebuffer';

      ws.on('open', () => {
        rec.state = 'open';
        rec.protocol = ws.protocol || '';
        log(`open ${id} ${url}`);
        push(id, { t: 'open', p: rec.protocol });
        resolve(true);
      });
      ws.on('message', (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        rec.received++;
        rec.receivedBytes += buf.length;
        stats.received++;
        stats.receivedBytes += buf.length;
        push(id, { t: 'message', b: buf.toString('base64') });
      });
      ws.on('error', (err) => {
        const msg = String((err && err.message) || err);
        rec.state = 'error';
        stats.errors++;
        log(`error ${id}: ${msg}`);
        push(id, { t: 'error', m: msg });
        if (rec.state === 'connecting') reject(msg);
      });
      ws.on('close', (code, reason) => {
        rec.state = 'closed';
        stats.closed++;
        log(`close ${id} ${code}`);
        push(id, { t: 'close', c: code, r: String(reason || '') });
      });
    }),
  );

  await page.exposeFunction('__obscuraWsSend', (id, b64) => {
    const rec = sockets.get(id);
    if (!rec || rec.state !== 'open') return false;
    try {
      const buf = Buffer.from(String(b64), 'base64');
      rec.ws.send(buf);
      rec.sent++;
      rec.sentBytes += buf.length;
      stats.sent++;
      stats.sentBytes += buf.length;
      return true;
    } catch (e) {
      stats.errors++;
      return false;
    }
  });

  await page.exposeFunction('__obscuraWsPoll', (id) => {
    const rec = sockets.get(id);
    if (!rec) return [{ t: 'close', c: 1006, r: 'unknown socket' }];
    const events = rec.queue;
    rec.queue = [];
    if (events.length === 0) return [];
    return events;
  });

  await page.exposeFunction('__obscuraWsClose', (id, code, reason) => {
    const rec = sockets.get(id);
    if (!rec) return false;
    try {
      rec.ws.close(code || 1000, reason || '');
      return true;
    } catch (e) {
      return false;
    }
  });

  await page.exposeFunction('__obscuraWsStats', (id) => {
    if (id == null) return { ...stats, sockets: sockets.size };
    const rec = sockets.get(id);
    if (!rec) return null;
    return {
      state: rec.state,
      sent: rec.sent,
      sentBytes: rec.sentBytes,
      received: rec.received,
      receivedBytes: rec.receivedBytes,
      dropped: rec.dropped,
      protocol: rec.protocol,
    };
  });

  return {
    stats,
    sockets,
    async dispose() {
      for (const [, rec] of sockets) {
        try {
          rec.ws.close();
        } catch {
          /* already closed */
        }
      }
      sockets.clear();
    },
  };
}
