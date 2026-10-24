// WebSocket bridge over raw CDP bindings (no Puppeteer).
//
// Page -> host: Runtime.addBinding functions carrying JSON strings.
// Host -> page: Runtime.evaluate calling the adapter's resolve/deliver hooks.
// The page is never blocked on a host command, so the per-session CDP
// serialization cannot deadlock.
import { WebSocket } from 'ws';

export const WS_ADAPTER = `(function () {
  window.__obscuraWsPendingOpen = {};
  window.__obscuraWsPendingPoll = {};
  window.__obscuraWsOpen = function (id, url, protos) {
    return new Promise(function (resolve, reject) {
      window.__obscuraWsPendingOpen[id] = { resolve: resolve, reject: reject };
      window.__obscuraWsOpenBinding(JSON.stringify([id, url, protos]));
    });
  };
  window.__obscuraWsResolveOpen = function (id, ok, err) {
    var p = window.__obscuraWsPendingOpen[id];
    if (!p) return;
    delete window.__obscuraWsPendingOpen[id];
    if (ok) p.resolve(true);
    else p.reject(new Error(err || 'open failed'));
  };
  window.__obscuraWsPoll = function (id) {
    return new Promise(function (resolve) {
      window.__obscuraWsPendingPoll[id] = resolve;
      window.__obscuraWsPollBinding(JSON.stringify([id]));
    });
  };
  window.__obscuraWsDeliver = function (id, json) {
    var r = window.__obscuraWsPendingPoll[id];
    if (!r) return;
    delete window.__obscuraWsPendingPoll[id];
    try { r(JSON.parse(json)); } catch (e) { r([]); }
  };
  window.__obscuraWsSend = function (id, b64) {
    window.__obscuraWsSendBinding(JSON.stringify([id, b64]));
    return Promise.resolve(true);
  };
  window.__obscuraWsClose = function (id, code, reason) {
    window.__obscuraWsCloseBinding(JSON.stringify([id, code, reason]));
    return Promise.resolve(true);
  };
})();`;

export async function installWsBridgeRaw(cdp, sessionId, { maxQueue = 8192, verbose = false } = {}) {
  const names = [
    '__obscuraWsOpenBinding',
    '__obscuraWsPollBinding',
    '__obscuraWsSendBinding',
    '__obscuraWsCloseBinding',
  ];
  for (const name of names) await cdp.send('Runtime.addBinding', { name }, sessionId);

  const sockets = new Map();
  const pendingPolls = new Set();
  const stats = {
    opened: 0, closed: 0, sent: 0, sentBytes: 0, received: 0, receivedBytes: 0, errors: 0,
    recent: [],
  };
  const record = (dir, buf) => {
    stats.recent.push({ t: Date.now(), dir, len: buf.length, b0: buf.length ? buf[0] : null });
    if (stats.recent.length > 200) stats.recent.shift();
  };
  const log = (...a) => { if (verbose) console.error('[ws-raw]', ...a); };

  const evalPage = (expression) => cdp.evaluate(sessionId, expression).catch((e) => log('eval', e.message));
  const deliver = (id, events) => {
    pendingPolls.delete(id);
    return evalPage(
      `window.__obscuraWsDeliver(${JSON.stringify(id)}, ${JSON.stringify(JSON.stringify(events))})`,
    );
  };
  const push = (id, evt) => {
    const rec = sockets.get(id);
    if (!rec) return;
    if (rec.queue.length >= maxQueue) {
      rec.dropped++;
      if (rec.dropped === 1) log(`socket ${id} queue full`);
      return;
    }
    rec.queue.push(evt);
    if (pendingPolls.has(id)) {
      const events = rec.queue;
      rec.queue = [];
      deliver(id, events);
    }
  };

  cdp.on('Runtime.bindingCalled', (params, sid) => {
    if (sid && sid !== sessionId) return;
    let args;
    try { args = JSON.parse(params.payload || '[]'); } catch { return; }
    const name = params.name;
    if (name === '__obscuraWsOpenBinding') {
      const [id, url, protocols] = args;
      let ws;
      try {
        ws = new WebSocket(url, Array.isArray(protocols) && protocols.length ? protocols : undefined);
      } catch (e) {
        stats.errors++;
        evalPage(`window.__obscuraWsResolveOpen(${JSON.stringify(id)}, false, ${JSON.stringify(String(e.message || e))})`);
        return;
      }
      const rec = { ws, queue: [], dropped: 0, state: 'connecting', sent: 0, sentBytes: 0, received: 0, receivedBytes: 0 };
      sockets.set(id, rec);
      stats.opened++;
      ws.binaryType = 'nodebuffer';
      ws.on('open', () => {
        rec.state = 'open';
        log(`open ${id} ${url}`);
        evalPage(`window.__obscuraWsResolveOpen(${JSON.stringify(id)}, true, null)`);
        push(id, { t: 'open', p: ws.protocol || '' });
      });
      ws.on('message', (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        rec.received++;
        rec.receivedBytes += buf.length;
        stats.received++;
        stats.receivedBytes += buf.length;
        record('in', buf);
        push(id, { t: 'message', b: buf.toString('base64') });
      });
      ws.on('error', (err) => {
        const msg = String((err && err.message) || err);
        rec.state = 'error';
        stats.errors++;
        log(`error ${id}: ${msg}`);
        evalPage(`window.__obscuraWsResolveOpen(${JSON.stringify(id)}, false, ${JSON.stringify(msg)})`);
        push(id, { t: 'error', m: msg });
      });
      ws.on('close', (code, reason) => {
        rec.state = 'closed';
        stats.closed++;
        log(`close ${id} ${code}`);
        push(id, { t: 'close', c: code, r: String(reason || '') });
      });
      return;
    }
    if (name === '__obscuraWsPollBinding') {
      const [id] = args;
      const rec = sockets.get(id);
      if (!rec) {
        deliver(id, [{ t: 'close', c: 1006, r: 'unknown socket' }]);
        return;
      }
      if (rec.queue.length) {
        const events = rec.queue;
        rec.queue = [];
        deliver(id, events);
      } else {
        pendingPolls.add(id);
      }
      return;
    }
    if (name === '__obscuraWsSendBinding') {
      const [id, b64] = args;
      const rec = sockets.get(id);
      if (!rec || rec.state !== 'open') return;
      try {
        const buf = Buffer.from(String(b64), 'base64');
        rec.ws.send(buf);
        rec.sent++;
        rec.sentBytes += buf.length;
        stats.sent++;
        stats.sentBytes += buf.length;
        record('out', buf);
      } catch { stats.errors++; }
      return;
    }
    if (name === '__obscuraWsCloseBinding') {
      const [id, code, reason] = args;
      const rec = sockets.get(id);
      if (rec) {
        try { rec.ws.close(code || 1000, reason || ''); } catch { /* */ }
      }
    }
  });

  return {
    stats,
    dispose() {
      for (const rec of sockets.values()) {
        try { rec.ws.terminate(); } catch { /* */ }
      }
      sockets.clear();
      pendingPolls.clear();
    },
  };
}
