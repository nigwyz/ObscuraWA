/**
 * Page-side WebSocket shim for the CDP tunnel.
 *
 * Obscura's built-in WebSocket never opens a socket, so `window.WebSocket` is
 * replaced here with one that speaks to `spike/lib/ws-bridge.mjs` over the
 * bindings that bridge installs. The page-facing API is the standard one:
 * CONNECTING/OPEN/CLOSING/CLOSED, send(), close(), onopen/onmessage/onerror/
 * onclose, addEventListener, binaryType, bufferedAmount.
 *
 * Everything is page-driven: the shim polls for inbound events and calls the
 * host only from page code, so the per-session CDP serialization in spike/10
 * never turns into a deadlock.
 */
(function () {
  'use strict';
  if (window.__obscuraWsShimVersion) return;
  window.__obscuraWsShimVersion = 1;

  var diag = {
    created: [],
    sent: 0,
    sentBytes: 0,
    received: 0,
    receivedBytes: 0,
    errors: [],
    maxFrame: 0,
    attempts: [],
    dropped: [],
    closes: [],
    frames: [],
  };
  window.__obscuraWsShim = diag;

  var CONNECTING = 0;
  var OPEN = 1;
  var CLOSING = 2;
  var CLOSED = 3;

  var nextId = 0;

  function b64FromBytes(bytes) {
    var chunk = 0x8000;
    var out = '';
    for (var i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  function bytesFromB64(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toBytes(data) {
    if (typeof data === 'string') {
      if (typeof TextEncoder === 'function') return new TextEncoder().encode(data);
      var arr = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) arr[i] = data.charCodeAt(i);
      return arr;
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer) {
      return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    }
    if (data && typeof data.arrayBuffer === 'function') return null; // Blob: async
    return null;
  }

  function Socket(url, protocols) {
    if (!(this instanceof Socket)) {
      throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
    }
    if (typeof url !== 'string' || !/^wss?:\/\//i.test(url)) {
      throw new DOMException(
        "Failed to construct 'WebSocket': The URL '" + url + "' is invalid.",
        'SyntaxError',
      );
    }
    this.url = url;
    this.protocol = '';
    this.extensions = '';
    this.binaryType = 'blob';
    this.readyState = CONNECTING;
    this.bufferedAmount = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._id = ++nextId;
    this._listeners = Object.create(null);
    this._closed = false;
    this._queue = 0;

    if (diag.created.length < 40) diag.created.push({ id: this._id, url: url });

    var self = this;
    if (typeof window.__obscuraWsOpen !== 'function') {
      setTimeout(function () {
        self._fail('tunnel bridge is not installed');
      }, 0);
      return;
    }
    var protos = protocols == null ? [] : Array.isArray(protocols) ? protocols : [protocols];
    Promise.resolve(window.__obscuraWsOpen(this._id, url, protos)).then(null, function (e) {
      self._fail(String(e));
    });
    this._pump();
  }

  Socket.prototype._pump = function () {
    var self = this;
    if (this._closed) return;
    Promise.resolve(window.__obscuraWsPoll(this._id)).then(
      function (events) {
        if (self._closed) return;
        if (events && events.length) {
          for (var i = 0; i < events.length; i++) self._handle(events[i]);
        }
        // 8ms, not 0ms: every poll resolves through a host-initiated CDP
        // command, and a tight loop starves ordinary page.evaluate calls.
        if (!self._closed) setTimeout(function () { self._pump(); }, 8);
      },
      function (e) {
        if (self._closed) return;
        diag.errors.push('poll: ' + String((e && e.message) || e));
        setTimeout(function () { self._pump(); }, 50);
      },
    );
  };

  Socket.prototype._handle = function (evt) {
    if (!evt) return;
    if (evt.t === 'open') {
      this.readyState = OPEN;
      this.protocol = evt.p || '';
      this._dispatch('open', { type: 'open' });
      return;
    }
    if (evt.t === 'error') {
      diag.errors.push(evt.m || 'socket error');
      this._dispatch('error', { type: 'error', message: evt.m || '' });
      return;
    }
    if (evt.t === 'close') {
      this._closed = true;
      this.readyState = CLOSED;
      if (diag.closes.length < 40) {
        diag.closes.push({ id: this._id, code: evt.c || 1000, reason: String(evt.r || '').slice(0, 80) });
      }
      this._dispatch('close', {
        type: 'close',
        code: evt.c || 1000,
        reason: evt.r || '',
        wasClean: true,
      });
      return;
    }
    if (evt.t === 'message') {
      var bytes = bytesFromB64(evt.b || '');
      diag.received++;
      diag.receivedBytes += bytes.length;
      if (bytes.length > diag.maxFrame) diag.maxFrame = bytes.length;
      if (diag.frames.length < 60) {
        diag.frames.push({
          id: this._id,
          dir: 'in',
          len: bytes.length,
          b0: bytes[0] ?? null,
          bt: this.binaryType,
          hasHandler: typeof this.onmessage === 'function',
          hasBlobArrayBuffer: typeof Blob === 'function' && typeof Blob.prototype.arrayBuffer === 'function',
          listeners: ((this._listeners && this._listeners.message) || []).length,
          hex: bytes.length <= 12
            ? Array.prototype.map.call(bytes, function (b) {
                return ('0' + b.toString(16)).slice(-2);
              }).join(' ')
            : null,
        });
      }
      var data;
      if (this.binaryType === 'arraybuffer') {
        data = bytes.buffer.slice(0);
      } else {
        data = new Blob([bytes]);
      }
      this._dispatch('message', { type: 'message', data: data });
    }
  };

  Socket.prototype._dispatch = function (type, evt) {
    evt.target = evt.currentTarget = this;
    evt.timeStamp = Date.now();
    var handler = this['on' + type];
    var list = (this._listeners[type] || []).slice();
    try {
      if (typeof handler === 'function') handler.call(this, evt);
    } catch (e) {
      diag.errors.push(type + ' handler: ' + String((e && e.message) || e));
    }
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].call(this, evt);
      } catch (e) {
        diag.errors.push(type + ' listener: ' + String((e && e.message) || e));
      }
    }
  };

  Socket.prototype._fail = function (msg) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = CLOSED;
    diag.errors.push(msg);
    this._dispatch('error', { type: 'error', message: msg });
    this._dispatch('close', { type: 'close', code: 1006, reason: msg, wasClean: false });
  };

  Socket.prototype.send = function (data) {
    if (this.readyState === CONNECTING) {
      throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
    }
    if (this.readyState !== OPEN) return;
    var self = this;
    var bytes = toBytes(data);
    if (bytes === null) {
      // Blob path: resolve asynchronously, per spec send() itself is sync.
      if (data && typeof data.arrayBuffer === 'function') {
        data.arrayBuffer().then(function (buf) {
          self._sendBytes(buf);
        });
      }
      return;
    }
    this._sendBytes(bytes);
  };

  Socket.prototype._sendBytes = function (bytes) {
    if (diag.attempts.length < 40) {
      diag.attempts.push({ id: this._id, len: bytes.length, state: this.readyState });
    }
    if (this.readyState !== OPEN) {
      if (diag.dropped.length < 20) {
        diag.dropped.push({ id: this._id, len: bytes.length, state: this.readyState });
      }
      return;
    }
    var b64 = b64FromBytes(bytes);
    this.bufferedAmount += bytes.length;
    this._queue++;
    var self = this;
    Promise.resolve(window.__obscuraWsSend(this._id, b64)).then(
      function () {
        self._queue--;
        self.bufferedAmount -= bytes.length;
        diag.sent++;
        diag.sentBytes += bytes.length;
        if (bytes.length > diag.maxFrame) diag.maxFrame = bytes.length;
        if (diag.frames.length < 60) {
          diag.frames.push({ id: self._id, dir: 'out', len: bytes.length, b0: bytes[0] ?? null });
        }
      },
      function (e) {
        self._queue--;
        self.bufferedAmount -= bytes.length;
        diag.errors.push('send: ' + String((e && e.message) || e));
      },
    );
  };

  Socket.prototype.close = function (code, reason) {
    if (this.readyState >= CLOSING) return;
    this.readyState = CLOSING;
    var self = this;
    if (typeof window.__obscuraWsClose === 'function') {
      Promise.resolve(window.__obscuraWsClose(this._id, code || 1000, reason || '')).then(
        function () {
          if (!self._closed) {
            self._closed = true;
            self.readyState = CLOSED;
            self._dispatch('close', { type: 'close', code: code || 1000, reason: reason || '', wasClean: true });
          }
        },
        function () {
          self._fail('close failed');
        },
      );
    } else {
      this._fail('tunnel bridge is not installed');
    }
  };

  Socket.prototype.addEventListener = function (type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  };

  Socket.prototype.removeEventListener = function (type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(function (h) {
      return h !== fn;
    });
  };

  Socket.prototype.dispatchEvent = function (evt) {
    this._dispatch(evt.type, evt);
    return true;
  };

  Socket.CONNECTING = CONNECTING;
  Socket.OPEN = OPEN;
  Socket.CLOSING = CLOSING;
  Socket.CLOSED = CLOSED;
  Socket.prototype.CONNECTING = CONNECTING;
  Socket.prototype.OPEN = OPEN;
  Socket.prototype.CLOSING = CLOSING;
  Socket.prototype.CLOSED = CLOSED;

  window.WebSocket = Socket;
})();
