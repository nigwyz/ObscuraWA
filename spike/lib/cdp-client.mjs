// Minimal CDP client over ws — replaces puppeteer-core in the production path.
import { WebSocket } from 'ws';

export async function connectCdp(port, { timeoutMs = 10_000 } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });

  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id != null) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result || {});
      return;
    }
    for (const fn of handlers.get(msg.method) || []) {
      try { fn(msg.params || {}, msg.sessionId); } catch { /* listener */ }
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const on = (method, fn) => {
    if (!handlers.has(method)) handlers.set(method, []);
    handlers.get(method).push(fn);
    return () => {
      const list = handlers.get(method) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  };

  const createPage = async () => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    return { targetId, sessionId };
  };

  const evaluate = async (sessionId, expression, { awaitPromise = true, returnByValue = true } = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
    }
    return r.result?.value;
  };

  const addScript = (sessionId, source) =>
    send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);

  const navigate = (sessionId, url) => send('Page.navigate', { url }, sessionId);

  const screenshot = async (sessionId, clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }, sessionId);
    return Buffer.from(r.data, 'base64');
  };

  const collectGarbage = (sessionId) => send('HeapProfiler.collectGarbage', {}, sessionId);
  const heapUsage = (sessionId) => send('Runtime.getHeapUsage', {}, sessionId);

  const close = () => { try { ws.close(); } catch { /* */ } };

  return { send, on, createPage, evaluate, addScript, navigate, screenshot, collectGarbage, heapUsage, close, ws };
}
