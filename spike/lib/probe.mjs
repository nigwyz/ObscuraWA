/**
 * In-page browser API battery. The function body is sent verbatim through
 * `Runtime.evaluate`, so it must be self-contained: no imports, no closures,
 * only page globals.
 *
 * Critical probes are the ones WhatsApp Web (libsignal, app shell) and
 * whatsapp-web.js rely on. `critical: true` failures are treated as
 * gate G2 failures.
 */
export async function apiProbe() {
  const results = [];

  const probe = async (name, critical, fn, timeoutMs = 10_000) => {
    const started = performance.now();
    try {
      const detail = await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs),
        ),
      ]);
      results.push({
        name,
        critical,
        ok: true,
        ms: Math.round(performance.now() - started),
        detail: detail ?? null,
      });
    } catch (err) {
      results.push({
        name,
        critical,
        ok: false,
        ms: Math.round(performance.now() - started),
        detail: String((err && err.message) || err),
      });
    }
  };

  // --- crypto (Signal protocol lives here) -------------------------------
  await probe('crypto.subtle.digest', true, async () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest).slice(0, 4)).join(',');
  });
  await probe('crypto.subtle.aes-gcm keygen+encrypt', true, async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new Uint8Array([7, 7, 7]),
    );
    const roundTrip = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ct,
    );
    return `roundtrip ${new Uint8Array(roundTrip)[0]}`;
  });
  await probe('crypto.subtle.ecdsa p-256 keygen+sign', true, async () => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      kp.privateKey,
      new Uint8Array([1, 2, 3]),
    );
    return `sig ${sig.byteLength}B`;
  });
  await probe('crypto.subtle.importKey raw', true, async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(3),
      { name: 'HMAC', hash: 'SHA-256' },
      true,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new Uint8Array([9]));
    return `hmac ${mac.byteLength}B`;
  });
  await probe('crypto.randomUUID', true, () => crypto.randomUUID());

  // --- storage ------------------------------------------------------------
  await probe('indexedDB open/put/get/delete', true, async () => {
    const dbName = `probe_${Date.now()}`;
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const put = await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put('hello', 'key');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
    const got = await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const r = tx.objectStore('kv').get('key');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const dbs = typeof indexedDB.databases === 'function'
      ? (await indexedDB.databases()).length
      : 'databases() unavailable';
    db.close();
    return { put, got, databasesCount: dbs };
  });
  await probe('indexedDB binary + crypto key record', true, async () => {
    const dbName = `probe_bin_${Date.now()}`;
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const binary = new Uint8Array(1024).fill(42);
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt'],
    );
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ binary, key, map: new Map([['a', 1]]) }, 'k');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const r = tx.objectStore('kv').get('k');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return {
      binaryOk: rec.binary instanceof Uint8Array && rec.binary[0] === 42,
      keyOk: rec.key instanceof CryptoKey,
      mapOk: rec.map instanceof Map,
    };
  });
  await probe('navigator.storage.estimate', true, async () => {
    if (!navigator.storage || !navigator.storage.estimate) {
      return 'navigator.storage.estimate unavailable';
    }
    const est = await navigator.storage.estimate();
    return { quota: est.quota, usage: est.usage };
  });
  await probe('localStorage roundtrip', true, () => {
    localStorage.setItem('probe', 'v1');
    const v = localStorage.getItem('probe');
    localStorage.removeItem('probe');
    return v;
  });
  await probe('sessionStorage roundtrip', true, () => {
    sessionStorage.setItem('probe', 'v1');
    const v = sessionStorage.getItem('probe');
    sessionStorage.removeItem('probe');
    return v;
  });

  // --- network ------------------------------------------------------------
  await probe('fetch https', true, async () => {
    const res = await fetch('https://web.whatsapp.com/', {
      method: 'GET',
      credentials: 'omit',
    });
    return `status ${res.status}`;
  });
  await probe('websocket wss://web.whatsapp.com', true, () => {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        fn(v);
      };
      let ws;
      try {
        ws = new WebSocket('wss://web.whatsapp.com/ws/chat');
      } catch (err) {
        return reject(new Error(`construct failed: ${err}`));
      }
      ws.onopen = () => {
        done(resolve, 'open');
        ws.close();
      };
      ws.onmessage = (ev) => done(resolve, `message ${String(ev.data).length}B`);
      ws.onerror = () => done(resolve, 'error event (TLS/socket layer reachable)');
      ws.onclose = (ev) =>
        done(resolve, `closed code=${ev.code} reason=${ev.reason || 'none'}`);
      setTimeout(() => done(resolve, 'timeout without open/close'), 10_000);
    });
  }, 15_000);

  // --- workers / messaging -------------------------------------------------
  await probe('Worker', true, () => {
    return new Promise((resolve, reject) => {
      const src = `self.onmessage = (e) => self.postMessage('echo:' + e.data);`;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const worker = new Worker(url);
      worker.onmessage = (ev) => {
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(ev.data);
      };
      worker.onerror = (err) => {
        worker.terminate();
        URL.revokeObjectURL(url);
        reject(new Error(err.message || 'worker error'));
      };
      worker.postMessage('hi');
      setTimeout(() => {
        worker.terminate();
        URL.revokeObjectURL(url);
        reject(new Error('worker timeout'));
      }, 8000);
    });
  });
  await probe('MessageChannel transfer', true, () => {
    const { port1, port2 } = new MessageChannel();
    return new Promise((resolve, reject) => {
      port2.onmessage = (ev) => resolve(ev.data);
      port1.postMessage('ping');
      setTimeout(() => reject(new Error('MessageChannel timeout')), 5000);
    });
  });
  await probe('Blob.text', true, async () => (await new Blob(['abc']).text()));

  // --- service worker -----------------------------------------------------
  await probe('navigator.serviceWorker', false, async () => {
    if (!navigator.serviceWorker) return 'navigator.serviceWorker unavailable';
    const reg = await navigator.serviceWorker.getRegistration();
    return { hasApi: true, registered: Boolean(reg) };
  });

  // --- observers (WhatsApp Web is a virtualized React app) -----------------
  await probe('ResizeObserver', true, () => {
    const el = document.createElement('div');
    el.style.cssText = 'width:10px;height:10px';
    document.body.appendChild(el);
    return new Promise((resolve, reject) => {
      const ro = new ResizeObserver((entries) => {
        ro.disconnect();
        el.remove();
        resolve(`entries ${entries.length}`);
      });
      ro.observe(el);
      el.style.width = '20px';
      setTimeout(() => {
        ro.disconnect();
        el.remove();
        reject(new Error('ResizeObserver timeout'));
      }, 5000);
    });
  });
  await probe('IntersectionObserver', true, () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return new Promise((resolve, reject) => {
      const io = new IntersectionObserver((entries) => {
        io.disconnect();
        el.remove();
        resolve(`entries ${entries.length}`);
      });
      io.observe(el);
      setTimeout(() => {
        io.disconnect();
        el.remove();
        reject(new Error('IntersectionObserver timeout'));
      }, 5000);
    });
  });
  await probe('MutationObserver', true, () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return new Promise((resolve, reject) => {
      const mo = new MutationObserver((records) => {
        mo.disconnect();
        el.remove();
        resolve(`records ${records.length}`);
      });
      mo.observe(el, { childList: true });
      el.appendChild(document.createElement('span'));
      setTimeout(() => {
        mo.disconnect();
        el.remove();
        reject(new Error('MutationObserver timeout'));
      }, 5000);
    });
  });
  await probe('requestIdleCallback', false, () => {
    return new Promise((resolve, reject) => {
      requestIdleCallback(() => resolve('idle'), { timeout: 3000 });
      setTimeout(() => reject(new Error('requestIdleCallback timeout')), 5000);
    });
  });

  // --- wasm / intl / misc runtime ------------------------------------------
  await probe('WebAssembly.validate', true, () => {
    const mod = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    return WebAssembly.validate(mod);
  });
  await probe('Intl timeZone ar-MA', true, () => {
    return new Intl.DateTimeFormat('ar-MA', {
      timeZone: 'Africa/Casablanca',
      dateStyle: 'medium',
    }).format(new Date('2026-01-01T00:00:00Z'));
  });
  await probe('Intl.supportedValuesOf', false, () => {
    return Intl.supportedValuesOf('timeZone').length;
  });
  await probe('structuredClone Map+Date', true, () => {
    const cloned = structuredClone({
      map: new Map([['k', 1]]),
      date: new Date('2020-01-01'),
      bytes: new Uint8Array([1, 2]),
    });
    return { map: cloned.map.get('k'), bytes: cloned.bytes[1] };
  });
  await probe('TextEncoder/TextDecoder emoji', true, () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder('utf-8', { fatal: true });
    const bytes = enc.encode('سﻻم 👋');
    return dec.decode(bytes);
  });
  await probe('AbortController/AbortSignal.timeout', true, async () => {
    const ac = new AbortController();
    ac.abort();
    let aborted = false;
    try {
      await fetch('https://web.whatsapp.com/', { signal: ac.signal });
    } catch {
      aborted = true;
    }
    const hasTimeout = typeof AbortSignal.timeout === 'function';
    return { abortWorks: aborted, signalTimeout: hasTimeout };
  });
  await probe('URL.createObjectURL revoke', true, () => {
    const url = URL.createObjectURL(new Blob(['x']));
    const ok = url.startsWith('blob:');
    URL.revokeObjectURL(url);
    return ok;
  });
  await probe('canvas 2d context', false, () => {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('2d'));
  });
  await probe('Notification.permission', false, () => Notification.permission);
  await probe('permissions.query notifications', false, async () => {
    if (!navigator.permissions || !navigator.permissions.query) {
      return 'navigator.permissions unavailable';
    }
    const st = await navigator.permissions.query({ name: 'notifications' });
    return st.state;
  });
  await probe('element.checkVisibility', false, () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const ok = typeof el.checkVisibility === 'function';
    const res = ok ? el.checkVisibility() : 'unavailable';
    el.remove();
    return { available: ok, detachedNotVisible: res };
  });
  await probe('getBoundingClientRect rendered box', true, () => {
    const el = document.createElement('div');
    el.textContent = 'x';
    el.style.cssText =
      'position:absolute;top:0;left:0;width:120px;height:40px;background:#000';
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    el.remove();
    return { w: r.width, h: r.height, display: cs.display };
  });
  await probe('performance.now', true, () => performance.now() > 0);

  return results;
}
