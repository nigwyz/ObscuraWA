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
    inlined: [],
    misses: [],
    errors: [],
    htmlSources: [],
    statuses: [],
    importCalls: [],
    sourceSizes: [],
    sources: [],
  };
  window.__obscuraWorkerPolyfill = diag;

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

  function makeScope(worker) {
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
      postMessage: function (msg) {
        worker._deliver(msg);
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
      WorkerGlobalScope: function WorkerGlobalScope() {},
      DedicatedWorkerGlobalScope: function DedicatedWorkerGlobalScope() {},
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

  function WorkerPolyfill(url) {
    var worker = this;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this._ev = Object.create(null);
    this._terminated = false;
    this._scope = null;
    this._pending = [];
    this._inlined = Object.create(null);
    this._started = false;
    this._preparing = false;
    this._url = resolveUrl(url);
    diag.created.push(this._url);

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
      for (var i = 0; i < pending.length; i++) this.postMessage(pending[i]);
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

  WorkerPolyfill.prototype._deliver = function (msg) {
    var worker = this;
    setTimeout(function () {
      if (worker._terminated) return;
      var scope = worker._scope;
      if (!scope) return;
      var evt = { data: msg, type: 'message' };
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

  WorkerPolyfill.prototype.postMessage = function (data) {
    if (this._terminated) return;
    if (this._started) {
      this._deliver(data);
      return;
    }
    this._pending.push(data);
    if (data && typeof data === 'object' && data.type === 'sr-init' && typeof data.bundleUrl === 'string') {
      this._prepareBundle(data.bundleUrl);
    }
  };

  WorkerPolyfill.prototype.terminate = function () {
    this._terminated = true;
    this._pending.length = 0;
    this._scope = null;
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
