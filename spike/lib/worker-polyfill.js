/**
 * Worker/global polyfill for Obscura.
 *
 * Why this exists: Obscura does not implement a real worker isolate. Its
 * `Worker` is a same-thread JS emulation (`new Function('scope','src',
 * 'with (scope) { eval(src) }')`) whose scope object only exposes crypto,
 * TextEncoder/Decoder, atob/btoa, timers, scheduler, fetch, console,
 * performance and location. WhatsApp Web's worker calls `importScripts(...)`
 * and reads `navigator.locks` / `navigator.storage` / `caches`, so it dies
 * before the app can reach a QR.
 *
 * This file is injected with Page.addScriptToEvaluateOnNewDocument, i.e. it
 * runs before any page script. It replaces `window.Worker` with an emulation
 * that:
 *   - prefetches the worker source and recursively *inlines* literal
 *     `importScripts("...")` calls, so the import is synchronous at run time;
 *   - gives the worker scope a real `navigator` (locks, storage, permissions),
 *     `caches`, `indexedDB`, `removeEventListener`, `self`, `globalThis`;
 *   - sets `location` to the worker script URL (not the page URL);
 *   - records every created URL, inlined dependency and import miss on
 *     `window.__obscuraWorkerPolyfill` so the spike can report ground truth.
 *
 * It is a probe, not a product: runtime-computed importScripts URLs cannot be
 * prefetched and are recorded as misses instead of silently failing.
 */
(function () {
  'use strict';
  if (window.__obscuraWorkerPolyfill) return;

  var diag = {
    version: 1,
    created: [],
    createdMeta: [],
    workerRegistry: Object.create(null),
    reused: 0,
    inlined: [],
    misses: [],
    errors: [],
    htmlSources: [],
    statuses: [],
    importCalls: [],
    sourceSizes: [],
    sources: [],
    messages: [],
    crypto: [],
    ws: [],
    rejections: [],
  };
  window.__obscuraWorkerPolyfill = diag;

  // Async socket handlers reject without throwing, so sync try/catch never sees
  // them; this is where a stalled Noise handshake would surface.
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var text = r && (r.stack || r.message) ? r.stack || r.message : String(r);
    if (diag.rejections.length < 20) diag.rejections.push(String(text).slice(0, 600));
  });

  if (window.crypto && window.crypto.subtle) instrumentSubtle(window.crypto.subtle);
  instrumentWebSocket();

  var resolved = new Map(); // absolute url -> source text with imports inlined

  function resolveUrl(u) {
    try {
      return new URL(String(u), location.href).href;
    } catch (e) {
      return String(u);
    }
  }

  function hasHtmlPrefix(text) {
    return text.replace(/^\uFEFF/, '').trimStart().charAt(0) === '<';
  }

  function literalArgs(callArgs) {
    var out = [];
    var re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    var m;
    while ((m = re.exec(callArgs))) out.push(m[2]);
    return out;
  }

  /**
   * Obscura's fetch()/XHR send a bare header set (Accept, Accept-Encoding,
   * Host, and a hardcoded Chrome/145 UA) with no Referer, Origin,
   * Accept-Language or Sec-Fetch-* headers. WhatsApp's edge answers that with a
   * 400 HTML page, which is what killed the worker bootstrap. Its XHR does not
   * enforce the forbidden-header list, so we can supply the headers a real
   * browser would have sent.
   */
  function browserHeaders(dest) {
    var ua = navigator.userAgent || '';
    var m = /Chrome\/(\d+)/.exec(ua);
    var major = m ? m[1] : '143';
    var langs =
      navigator.languages && navigator.languages.length
        ? navigator.languages.join(',')
        : 'en-US,en';
    return {
      Accept: '*/*',
      'Accept-Language': langs + ';q=0.9',
      Referer: location.href,
      'Sec-Fetch-Dest': dest || 'script',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Ch-Ua':
        '"Google Chrome";v="' +
        major +
        '", "Chromium";v="' +
        major +
        '", "Not A(Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Linux"',
    };
  }

  function xhrGetText(url) {
    return new Promise(function (resolve, reject) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        var sameOrigin = false;
        try {
          sameOrigin = new URL(url, location.href).origin === location.origin;
        } catch (e) {
          sameOrigin = false;
        }
        // CDN assets answer with `Access-Control-Allow-Origin: *`, which CORS
        // forbids for credentialed requests; same-origin needs no flag at all.
        xhr.withCredentials = sameOrigin;
        var headers = sameOrigin ? browserHeaders('script') : {};
        for (var k in headers) {
          if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
          try {
            xhr.setRequestHeader(k, headers[k]);
          } catch (e) {
            diag.errors.push('setRequestHeader ' + k + ': ' + String(e.message || e));
          }
        }
        xhr.onload = function () {
          diag.statuses.push({ url: url, status: xhr.status });
          if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
          else reject(new Error('HTTP ' + xhr.status + ' for ' + url));
        };
        xhr.onerror = function () {
          diag.statuses.push({ url: url, status: 'network-error' });
          reject(new Error('network error for ' + url));
        };
        xhr.send();
      } catch (e) {
        reject(e);
      }
    });
  }

  async function expandImports(url, base, depth) {
    var abs = resolveUrl(base ? new URL(String(url), base).href : url);
    if (resolved.has(abs)) return resolved.get(abs);

    var text;
    if (abs.indexOf('data:') === 0) {
      var res = await fetch(abs);
      text = await res.text();
    } else {
      text = await xhrGetText(abs);
    }
    if (hasHtmlPrefix(text)) {
      diag.htmlSources.push(abs);
      throw new Error('importScripts got HTML for ' + abs);
    }

    if (depth > 0) {
      var callRe = /importScripts\s*\(([\s\S]*?)\)/g;
      var calls = [];
      var c;
      while ((c = callRe.exec(text))) calls.push({ match: c[0], args: c[1] });
      for (var i = 0; i < calls.length; i++) {
        if (diag.importCalls.length < 40) {
          diag.importCalls.push({ file: abs, args: calls[i].args.slice(0, 240) });
        }
        var urls = literalArgs(calls[i].args);
        if (!urls.length) continue;
        var inlined = '';
        for (var j = 0; j < urls.length; j++) {
          try {
            var depUrl = new URL(urls[j], abs).href;
            diag.inlined.push(depUrl);
            inlined += '\n/* inlined ' + depUrl + ' */\n' + (await expandImports(depUrl, abs, depth - 1));
          } catch (e) {
            diag.errors.push(String(e.message || e));
            diag.misses.push(new URL(urls[j], abs).href);
          }
        }
        if (inlined) text = text.split(calls[i].match).join(inlined);
      }
    }

    diag.sourceSizes.push({ url: abs, bytes: text.length });
    if (diag.sources.length < 4 && text.length < 200000) {
      diag.sources.push({ url: abs, text: text });
    }
    resolved.set(abs, text);
    return text;
  }

  function makeNavigator() {
    var locks = {
      request: function (name, arg1, arg2) {
        var cb = typeof arg1 === 'function' ? arg1 : arg2;
        var opts = typeof arg1 === 'object' && arg1 ? arg1 : {};
        if (typeof cb !== 'function') return Promise.resolve(undefined);
        try {
          return Promise.resolve(cb({ name: name, mode: opts.mode || 'exclusive' }));
        } catch (e) {
          return Promise.reject(e);
        }
      },
      query: function () {
        return Promise.resolve({ held: [], pending: [] });
      },
    };
    var storage = {
      estimate: function () {
        return Promise.resolve({ usage: 0, quota: 64 * 1024 * 1024 });
      },
      persist: function () {
        return Promise.resolve(true);
      },
      persisted: function () {
        return Promise.resolve(true);
      },
    };
    return {
      locks: locks,
      storage: storage,
      hardwareConcurrency: (navigator && navigator.hardwareConcurrency) || 4,
      userAgent: (navigator && navigator.userAgent) || '',
      language: (navigator && navigator.language) || 'en-US',
      languages: (navigator && navigator.languages) || ['en-US'],
      platform: (navigator && navigator.platform) || '',
      onLine: true,
      permissions: {
        query: function () {
          return Promise.resolve({ state: 'granted', onchange: null });
        },
      },
      serviceWorker: undefined,
    };
  }

  function makeCaches() {
    var cache = {
      match: function () {
        return Promise.resolve(undefined);
      },
      matchAll: function () {
        return Promise.resolve([]);
      },
      add: function () {
        return Promise.resolve();
      },
      addAll: function () {
        return Promise.resolve();
      },
      put: function () {
        return Promise.resolve();
      },
      delete: function () {
        return Promise.resolve(false);
      },
      keys: function () {
        return Promise.resolve([]);
      },
    };
    return {
      open: function () {
        return Promise.resolve(cache);
      },
      keys: function () {
        return Promise.resolve([]);
      },
      has: function () {
        return Promise.resolve(false);
      },
      delete: function () {
        return Promise.resolve(false);
      },
      match: function () {
        return Promise.resolve(undefined);
      },
    };
  }

  function instrumentSubtle(subtle) {
    if (!subtle || subtle.__obscuraWrapped) return;
    try {
      subtle.__obscuraWrapped = true;
    } catch (e) {
      return;
    }
    var ops = ['digest', 'generateKey', 'importKey', 'exportKey', 'sign', 'verify',
      'encrypt', 'decrypt', 'deriveKey', 'deriveBits', 'wrapKey', 'unwrapKey'];
    for (var i = 0; i < ops.length; i++) {
      (function (op) {
        var orig = subtle[op];
        if (typeof orig !== 'function') {
          diag.crypto.push({ op: op, state: 'missing' });
          return;
        }
        subtle[op] = function () {
          var args = arguments;
          var a0 = args[0];
          var alg = typeof a0 === 'string' ? a0 : a0 && (a0.name || a0.hash || a0);
          var rec = {
            op: op,
            alg: String(alg),
            curve: a0 && a0.namedCurve ? String(a0.namedCurve) : null,
          };
          var push = function () {
            if (diag.crypto.length < 120) diag.crypto.push(rec);
          };
          try {
            var out = orig.apply(subtle, args);
            if (out && typeof out.then === 'function') {
              return out.then(
                function (v) {
                  rec.ok = true;
                  push();
                  return v;
                },
                function (e) {
                  rec.ok = false;
                  rec.err = String((e && e.message) || e);
                  push();
                  throw e;
                },
              );
            }
            rec.ok = true;
            push();
            return out;
          } catch (e) {
            rec.ok = false;
            rec.err = String((e && e.message) || e);
            push();
            throw e;
          }
        };
      })(ops[i]);
    }
  }

  function instrumentWebSocket() {
    var Native = window.WebSocket;
    if (!Native || Native.__obscuraWrapped) return;
    function WS(url, protocols) {
      var ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      var rec = { url: String(url), state: 'created' };
      if (diag.ws.length < 20) diag.ws.push(rec);
      try {
        ws.addEventListener('open', function () {
          rec.state = 'open';
        });
        ws.addEventListener('error', function () {
          rec.state = 'error';
        });
        ws.addEventListener('close', function (e) {
          rec.state = 'closed';
          rec.code = e && e.code;
          rec.reason = e && e.reason ? String(e.reason).slice(0, 80) : undefined;
        });
        ws.addEventListener('message', function () {
          rec.messages = (rec.messages || 0) + 1;
        });
      } catch (e) {
        /* listener attach failed */
      }
      return ws;
    }
    WS.prototype = Native.prototype;
    WS.CONNECTING = 0;
    WS.OPEN = 1;
    WS.CLOSING = 2;
    WS.CLOSED = 3;
    WS.__obscuraWrapped = true;
    try {
      window.WebSocket = WS;
    } catch (e) {
      /* frozen */
    }
  }

  function makeScope(worker) {
    // WhatsApp's worker bootstrap asserts `self instanceof
    // DedicatedWorkerGlobalScope`; a plain object fails that check with
    // "Minified invariant #56318". Give the scope the correct prototype chain.
    function WorkerGlobalScope() {}
    function DedicatedWorkerGlobalScope() {}
    DedicatedWorkerGlobalScope.prototype = Object.create(WorkerGlobalScope.prototype);
    DedicatedWorkerGlobalScope.prototype.constructor = DedicatedWorkerGlobalScope;

    var scope = {
      location: new URL(worker._url),
      origin: (function () {
        try {
          return new URL(worker._url).origin;
        } catch (e) {
          return location.origin;
        }
      })(),
      name: '',
      navigator: makeNavigator(),
      indexedDB: window.indexedDB,
      IDBKeyRange: window.IDBKeyRange,
      caches: makeCaches(),
      importScripts: function () {
        // The bundle is prefetched and co-evaluated with the init script (see
        // WorkerPolyfill#_prepareBundle), so an import of an already-known URL
        // is a no-op here. Anything else was computed at runtime and cannot be
        // resolved synchronously.
        var missing = [];
        for (var i = 0; i < arguments.length; i++) {
          var abs = new URL(String(arguments[i]), worker._url).href;
          if (worker._inlined[abs]) continue;
          diag.misses.push(abs);
          missing.push(abs);
        }
        if (missing.length) {
          throw new Error('importScripts: not prefetched: ' + missing.join(', '));
        }
      },
      postMessage: function (msg, transfer) {
        worker._postToPage(msg, transfer);
      },
      addEventListener: function (type, fn) {
        if (!worker._ev[type]) worker._ev[type] = [];
        worker._ev[type].push(fn);
      },
      removeEventListener: function (type, fn) {
        if (worker._ev[type]) worker._ev[type] = worker._ev[type].filter(function (h) {
          return h !== fn;
        });
      },
      dispatchEvent: function (evt) {
        var ls = worker._ev[evt.type] || [];
        for (var i = 0; i < ls.length; i++) ls[i].call(scope, evt);
        return true;
      },
      close: function () {
        worker.terminate();
      },
      onmessage: null,
      onmessageerror: null,
      WorkerGlobalScope: WorkerGlobalScope,
      DedicatedWorkerGlobalScope: DedicatedWorkerGlobalScope,
      crypto: window.crypto,
      Crypto: window.Crypto,
      TextEncoder: window.TextEncoder,
      TextDecoder: window.TextDecoder,
      atob: window.atob,
      btoa: window.btoa,
      setTimeout: window.setTimeout,
      setInterval: window.setInterval,
      clearTimeout: window.clearTimeout,
      clearInterval: window.clearInterval,
      queueMicrotask: window.queueMicrotask,
      scheduler: window.scheduler,
      Scheduler: window.Scheduler,
      fetch: window.fetch,
      XMLHttpRequest: window.XMLHttpRequest,
      WebSocket: window.WebSocket,
      MessageChannel: window.MessageChannel,
      MessagePort: window.MessagePort,
      Blob: window.Blob,
      File: window.File,
      FileReader: window.FileReader,
      FormData: window.FormData,
      Headers: window.Headers,
      Request: window.Request,
      Response: window.Response,
      URL: window.URL,
      URLSearchParams: window.URLSearchParams,
      AbortController: window.AbortController,
      structuredClone: window.structuredClone,
      console: window.console,
      performance: window.performance,
      ErrorEvent: window.ErrorEvent,
      Event: window.Event,
      CustomEvent: window.CustomEvent,
    };
    scope.self = scope;
    scope.globalThis = scope;
    Object.setPrototypeOf(scope, DedicatedWorkerGlobalScope.prototype);

    // The bundle's module factory receives the worker global and reads
    // intrinsics as *properties* (e.g. `self.Promise.allSettled`), so a
    // missing property is undefined even though the identifier would have
    // resolved through the outer realm. Mirror the standard globals.
    var intrinsics = [
      'Promise', 'Object', 'Array', 'JSON', 'Math', 'Number', 'String', 'Boolean',
      'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error',
      'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError',
      'EvalError', 'Function', 'Proxy', 'Reflect', 'BigInt', 'ArrayBuffer',
      'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
      'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
      'BigInt64Array', 'BigUint64Array', 'SharedArrayBuffer', 'Atomics', 'WeakRef',
      'FinalizationRegistry', 'Intl', 'typeof', 'parseInt', 'parseFloat', 'isNaN',
      'isFinite', 'decodeURI', 'decodeURIComponent', 'encodeURI',
      'encodeURIComponent', 'escape', 'unescape', 'DOMException',
      'BroadcastChannel', 'AbortSignal', 'ImageData', 'OffscreenCanvas',
    ];
    for (var gi = 0; gi < intrinsics.length; gi++) {
      var name = intrinsics[gi];
      if (name === 'typeof') continue;
      if (!(name in scope) && typeof window[name] !== 'undefined') {
        scope[name] = window[name];
      }
    }
    return scope;
  }

  function WorkerPolyfill(url, options) {
    var worker = this;
    this._name = (options && options.name) || '';
    // WAWebStartBackendWorker retries the backend worker under the same name.
    // Reuse a live instance so retries do not allocate a second V8 realm.
    if (this._name) {
      var existing = diag.workerRegistry[this._name];
      if (existing && !existing._terminated) {
        diag.reused += 1;
        return existing;
      }
    }
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this._ev = Object.create(null);      // worker-scope listeners
    this._pageEv = Object.create(null);  // page-side listeners
    this._terminated = false;
    this._scope = null;
    this._pending = [];
    this._inlined = Object.create(null);
    this._started = false;
    this._preparing = false;
    this._url = resolveUrl(url);
    diag.created.push(this._url);
    if (this._name) diag.workerRegistry[this._name] = this;
    if (diag.createdMeta.length < 20) {
      diag.createdMeta.push({
        url: this._url,
        name: this._name,
        type: (options && options.type) || 'classic',
        stack: String(new Error().stack || '').slice(0, 700),
      });
    }

    var blobSource = window.__blobStore && window.__blobStore[String(url)];
    var blobIsWorkerScript = blobSource !== undefined && String(url).indexOf('blob:') === 0;

    this._ready = (async function () {
      try {
        var src;
        if (blobIsWorkerScript) {
          src = blobSource;
        } else {
          src = await expandImports(url, null, 1);
        }
        if (hasHtmlPrefix(src)) {
          diag.htmlSources.push(worker._url);
          throw new Error('worker source is HTML for ' + worker._url);
        }
        worker._source = src;
        // WhatsApp's worker is a shell: it boots, then waits for an `sr-init`
        // message carrying the real bundle URL and calls importScripts on it at
        // runtime. We cannot prefetch an unknown URL, so when the shell is
        // detected we hold the run until the page tells us the bundle.
        var waitsForBundle = src.indexOf('sr-init') !== -1;
        if (waitsForBundle) {
          setTimeout(function () {
            if (!worker._started) worker._run();
          }, 5000);
        } else {
          setTimeout(function () {
            worker._run();
          }, 0);
        }
      } catch (e) {
        diag.errors.push(String(e && e.stack ? e.stack : e && e.message ? e.message : e));
        worker._emitError(e);
      }
    })();
  }

  WorkerPolyfill.prototype._run = function () {
    if (this._terminated || this._scope || this._source === undefined) return;
    var scope = makeScope(this);
    try {
      var fn = new Function('scope', 'source', 'with (scope) { eval(source); }');
      fn.call(scope, scope, this._source);
      this._scope = scope;
      this._started = true;
      var pending = this._pending.splice(0);
      for (var i = 0; i < pending.length; i++) this.postMessage(pending[i].data, pending[i].transfer);
    } catch (e) {
      diag.errors.push(String(e && e.stack ? e.stack : e && e.message ? e.message : e));
      this._emitError(e);
    }
  };

  /**
   * Fetch the bundle the shell asked for and co-evaluate it with the shell in a
   * single function scope, so `StartBundle` (declared by the bundle) is visible
   * to the shell and the shell's later `importScripts(bundleUrl)` is a no-op.
   */
  WorkerPolyfill.prototype._prepareBundle = function (url) {
    var worker = this;
    if (this._preparing || this._started) return;
    this._preparing = true;
    var abs = resolveUrl(url);
    xhrGetText(abs).then(
      function (text) {
        worker._inlined[abs] = true;
        diag.inlined.push(abs);
        worker._source = worker._source + '\n;\n/* bundle: ' + abs + ' */\n' + text;
        worker._run();
      },
      function (e) {
        diag.errors.push('bundle fetch: ' + String(e && e.message ? e.message : e));
        // Run the shell anyway so the failure surfaces in its own error paths.
        worker._run();
      },
    );
  };

  function traceMsg(dir, data) {
    if (diag.messages.length >= 400) return;
    var type = 'non-object';
    if (data && typeof data === 'object') type = String(data.type || '(untyped)');
    else if (typeof data === 'string') type = 'string:' + data.slice(0, 24);
    diag.messages.push({ dir: dir, type: type });
  }

  WorkerPolyfill.prototype._deliver = function (msg, transfer) {
    var worker = this;
    traceMsg('page->worker', msg);
    setTimeout(function () {
      if (worker._terminated) return;
      var scope = worker._scope;
      if (!scope) return;
      var evt = { data: msg, type: 'message', ports: Array.isArray(transfer) ? transfer : [] };
      try {
        if (typeof scope.onmessage === 'function') scope.onmessage.call(scope, evt);
        var ls = worker._ev.message || [];
        for (var i = 0; i < ls.length; i++) ls[i].call(scope, evt);
      } catch (e) {
        diag.errors.push(String(e && e.stack ? e.stack : e && e.message ? e.message : e));
        worker._emitError(e);
      }
    }, 0);
  };

  WorkerPolyfill.prototype._postToPage = function (msg, transfer) {
    var worker = this;
    traceMsg('worker->page', msg);
    setTimeout(function () {
      if (worker._terminated) return;
      var evt = { data: msg, type: 'message', ports: Array.isArray(transfer) ? transfer : [] };
      try {
        if (typeof worker.onmessage === 'function') worker.onmessage.call(worker, evt);
        var ls = worker._pageEv.message || [];
        for (var i = 0; i < ls.length; i++) ls[i].call(worker, evt);
      } catch (e) {
        diag.errors.push(String(e && e.stack ? e.stack : e && e.message ? e.message : e));
        worker._emitError(e);
      }
    }, 0);
  };

  WorkerPolyfill.prototype._emitError = function (e) {
    var evt = {
      type: 'error',
      message: String(e && e.message ? e.message : e),
      error: e,
      stack: String(e && e.stack ? e.stack : ''),
    };
    try {
      if (typeof this.onerror === 'function') this.onerror(evt);
      var ls = this._ev.error || [];
      for (var i = 0; i < ls.length; i++) ls[i].call(this, evt);
    } catch (_) {
      /* listener threw */
    }
  };

  WorkerPolyfill.prototype.postMessage = function (data, transfer) {
    if (this._terminated) return;
    traceMsg('page->worker', data);
    if (data && typeof data === 'object') {
      diag.posts = diag.posts || [];
      if (diag.posts.length < 80) {
        diag.posts.push({ type: String(data.type || '(untyped)'), keys: Object.keys(data).slice(0, 12) });
      }
    }
    if (data && data.type === 'ww-hrp-init' && data.hrp) {
      try {
        var hrp = data.hrp || {};
        var hsrp = hrp.hsrp || {};
        var map = (hsrp.hblp && hsrp.hblp.rsrcMap) || {};
        var keys = Object.keys(map);
        diag.hrp = {
          keys: keys.slice(0, 40),
          backend: map.WAWebBackendWorkerV2Bundle || null,
          resources: keys.slice(0, 12).map(function (k) {
            var r = map[k] || {};
            return { k: k, type: r.type, src: r.src };
          }),
          tiered: hrp.tieredResources || null,
        };
      } catch (e) {
        diag.errors.push('hrp capture: ' + String(e && e.message ? e.message : e));
      }
    }
    if (this._started) {
      this._deliver(data, transfer);
      return;
    }
    this._pending.push({ data: data, transfer: transfer });
    if (data && typeof data === 'object' && data.type === 'sr-init' && typeof data.bundleUrl === 'string') {
      this._prepareBundle(data.bundleUrl);
    }
  };

  WorkerPolyfill.prototype.terminate = function () {
    this._terminated = true;
    this._pending.length = 0;
    this._scope = null;
    if (this._name && diag.workerRegistry[this._name] === this) {
      delete diag.workerRegistry[this._name];
    }
  };

  WorkerPolyfill.prototype.addEventListener = function (type, fn) {
    if (!this._ev[type]) this._ev[type] = [];
    this._ev[type].push(fn);
  };

  WorkerPolyfill.prototype.removeEventListener = function (type, fn) {
    if (this._ev[type]) {
      this._ev[type] = this._ev[type].filter(function (h) {
        return h !== fn;
      });
    }
  };

  window.Worker = WorkerPolyfill;

  // Non-critical G2 gaps that some boot paths touch. `register` already exists
  // in Obscura; only the read side is missing.
  if (window.navigator && navigator.serviceWorker) {
    if (typeof navigator.serviceWorker.getRegistration !== 'function') {
      navigator.serviceWorker.getRegistration = function () {
        return Promise.resolve(undefined);
      };
    }
    if (typeof navigator.serviceWorker.getRegistrations !== 'function') {
      navigator.serviceWorker.getRegistrations = function () {
        return Promise.resolve([]);
      };
    }
  }
  if (!window.caches) {
    window.caches = makeCaches();
  }
})();
