// Internal trace for WhatsApp's Noise handshake.
//
// The public symptom is only "43 B out, 350 B in, then the server closes 1011".
// That does not say where the page gives up. WhatsApp's own logger does not
// reach console, so this wraps the exported modules by name (window.require)
// and records the handshake call sequence, result sizes, and every rejection.
//
// Only metadata is recorded: function names, byte lengths, null/undefined.
// No key material or frame payloads.
(function () {
  'use strict';
  if (window.__waDiagInstalled) return;
  window.__waDiagInstalled = true;

  var diag = (window.__waDiag = { events: [], errors: [], patches: [] });
  var __modRegistry = Object.create(null);
  var MAX_EVENTS = 2000;

  function rec(event, detail) {
    if (diag.events.length >= MAX_EVENTS) return;
    diag.events.push({ t: Date.now(), event: event, detail: detail == null ? null : detail });
  }
  function err(where, e) {
    if (diag.errors.length >= 40) return;
    var text = e && e.name ? e.name + ': ' + e.message : String(e);
    diag.errors.push({ t: Date.now(), where: where, error: String(text).slice(0, 300) });
  }
  function sizeOf(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value;
    if (value.byteLength != null) return value.byteLength;
    if (value.length != null) return value.length;
    return typeof value;
  }

  function wrapFn(obj, name, label, enter) {
    if (!obj || typeof obj[name] !== 'function' || obj[name].__waWrapped) return false;
    var orig = obj[name];
    var wrapped = function () {
      rec(label + ':enter', enter ? enter(arguments) : null);
      try {
        var out = orig.apply(this, arguments);
        if (out && typeof out.then === 'function') {
          return out.then(
            function (value) {
              rec(label + ':ok', sizeOf(value));
              return value;
            },
            function (e) {
              err(label, e);
              throw e;
            },
          );
        }
        rec(label + ':sync-ok', sizeOf(out));
        return out;
      } catch (e) {
        err(label, e);
        throw e;
      }
    };
    wrapped.__waWrapped = true;
    obj[name] = wrapped;
    diag.patches.push(label);
    return true;
  }

  function patchPrototype(Cls, names, label) {
    if (!Cls || !Cls.prototype || Cls.prototype.__waWrapped) return false;
    names.forEach(function (name) {
      var orig = Cls.prototype[name];
      if (typeof orig !== 'function') return;
      Cls.prototype[name] = function () {
        rec(label + '.' + name + ':enter', null);
        try {
          var out = orig.apply(this, arguments);
          if (out && typeof out.then === 'function') {
            return out.then(
              function (value) {
                rec(label + '.' + name + ':ok', sizeOf(value));
                return value;
              },
              function (e) {
                err(label + '.' + name, e);
                throw e;
              },
            );
          }
          rec(label + '.' + name + ':sync-ok', sizeOf(out));
          return out;
        } catch (e) {
          err(label + '.' + name, e);
          throw e;
        }
      };
    });
    Cls.prototype.__waWrapped = true;
    diag.patches.push(label);
    return true;
  }

  // The lazy bridge module requires WAWebCryptoHkdf, which this build never
  // defines; WACryptoHkdf is the same API under its older name. Define an
  // alias before the bridge chunk's factory resolves so the deferred load can
  // complete instead of dying with "Requiring unknown module".
  function installHkdfAlias() {
    if (window.__waHkdfAlias || typeof window.__d !== 'function') return false;
    try {
      window.__d(
        'WAWebCryptoHkdf',
        ['WACryptoHkdf'],
        function (t, n, r, o, a, i, l) {
          var m = r('WACryptoHkdf');
          if (m) for (var k in m) l[k] = m[k];
        },
        98,
      );
      window.__waHkdfAlias = true;
      rec('alias', 'WAWebCryptoHkdf -> WACryptoHkdf');
      diag.patches.push('hkdf-alias');
      return true;
    } catch (e) {
      err('hkdf alias', e);
      return false;
    }
  }

  // Three bridge modules are absent from the served page chunk, so the
  // aggregator module can never resolve. They are unrelated to the login
  // handshake; stub them so the real DeviceInfoBridgeApi can register.
  function installBridgeStubs() {
    if (window.__waBridgeStubs) return;
    var stubs = [
      ['WAWebMemberLabelBridgeApi', 'MemberLabelBridgeApi'],
      ['WAWebNewsletterBridgeApi', 'NewsletterBridgeApi'],
      ['WAWebThreadBridgeApi', 'ThreadBridgeApi'],
    ];
    for (var i = 0; i < stubs.length; i++) {
      (function (name, exportName) {
        try {
          window.__d(
            name,
            [],
            function (t, n, r, o, a, i2, l) {
              l[exportName] = {};
            },
            98,
          );
          rec('stub', name);
        } catch (e) {
          err('stub ' + name, e);
        }
      })(stubs[i][0], stubs[i][1]);
    }
    window.__waBridgeStubs = true;
    diag.patches.push('bridge-stubs');
  }

  function patchAll() {
    installHkdfAlias();
    installBridgeStubs();
    if (typeof window.require !== 'function') return false;

    var mods = {};
    var required = [
      'WANoiseHandshake',
      'WAWebCryptoCurve25519',
      'WAWebCryptoHkdf',
      'WAWebNoiseInfoWorkerCompatible',
      'WAWebUserPrefsInfoStore',
      'WAWebProcessCertificate',
      'WAFrameSocket',
      'WAWebOpenChatSocket',
      'WAWebGetClientPayloadForLogin',
      'WAWebGetClientPayloadForRegistration',
      'WAWebClientPayload',
      'WAWebRegisterPassiveTasksForConnectWorkerCompatible',
      'WAWebRegisterPassiveTasksForConnect',
      'WAWebSignalStoreApi',
      'WAWebUserPrefsMeUser',
      'WACryptoHkdf',
      'WACryptoSha256',
      'WACryptoHmac',
      'WAWebSyncdMdSyncFieldstatMeta',
      'WAWebBackendApi',
      'WAWebClientPayloadReleaseChannel',
      'WADynamicRouterAsync',
      'WAWebBackendApi',
      'RequireDeferredReference',
    ];
    for (var i = 0; i < required.length; i++) {
      try {
        mods[required[i]] = window.require(required[i]);
      } catch (e) {
        return false; // module graph not ready yet
      }
    }

    var NH = mods.WANoiseHandshake && mods.WANoiseHandshake.NoiseHandshake;
    patchPrototype(NH, ['start', 'authenticate', 'mixIntoKey', 'sendAndReceive', 'encrypt', 'decrypt', 'finish', '$7'], 'NoiseHandshake');

    var curve = mods.WAWebCryptoCurve25519;
    wrapFn(curve, 'sharedSecret', 'curve.sharedSecret', function (args) {
      return { priv: sizeOf(args[0]), pub: sizeOf(args[1]) };
    });
    wrapFn(curve, 'keyPair', 'curve.keyPair');

    wrapFn(mods.WAWebCryptoHkdf, 'extractWithSaltAndExpand', 'hkdf.extractWithSaltAndExpand', function (args) {
      return { salt: sizeOf(args[0]), ikm: sizeOf(args[1]), info: sizeOf(args[2]), len: sizeOf(args[3]) };
    });
    wrapFn(mods.WAWebCryptoHkdf, 'extractAndExpand', 'hkdf.extractAndExpand');
    wrapFn(mods.WAWebCryptoHkdf, 'expand', 'hkdf.expand');

    wrapFn(mods.WACryptoSha256, 'sha256', 'sha256');
    wrapFn(mods.WACryptoHmac, 'extractSha256', 'hmac.extractSha256');
    wrapFn(mods.WACryptoHmac, 'encodeKeySha256', 'hmac.encodeKeySha256');
    wrapFn(mods.WACryptoHmac, 'sign', 'hmac.sign');

    // Where the client finish actually blocks: the payload promise.
    wrapFn(mods.WAWebGetClientPayloadForLogin, 'getClientPayloadForLogin', 'payload.login');
    wrapFn(mods.WAWebGetClientPayloadForRegistration, 'getClientPayloadForRegistration', 'payload.register');
    wrapFn(mods.WAWebClientPayload, 'getClientPayloadForLogin', 'clientPayload.login');
    wrapFn(mods.WAWebClientPayload, 'getClientPayloadForRegistration', 'clientPayload.register');

    var passive = mods.WAWebRegisterPassiveTasksForConnectWorkerCompatible;
    wrapFn(passive, 'registerPassiveTasksForConnect', 'passive.register');
    wrapFn(passive, 'shouldConnectAsPassiveMode', 'passive.shouldConnect');
    wrapFn(mods.WAWebRegisterPassiveTasksForConnect, 'registerPassiveTasksForConnect', 'passive.registerImpl');
    wrapFn(mods.WAWebRegisterPassiveTasksForConnect, 'shouldConnectAsPassiveMode', 'passive.shouldConnectImpl');

    var signal = mods.WAWebSignalStoreApi && mods.WAWebSignalStoreApi.waSignalStore;
    if (signal) {
      wrapFn(signal, 'getRegistrationInfo', 'signal.getRegistrationInfo');
      wrapFn(signal, 'getSignedPreKey', 'signal.getSignedPreKey');
    }
    wrapFn(mods.WAWebUserPrefsMeUser, 'getMeDevicePnOrThrow_DO_NOT_USE', 'prefs.meDevicePn');

    var fieldstat = mods.WAWebSyncdMdSyncFieldstatMeta && mods.WAWebSyncdMdSyncFieldstatMeta.MdSyncFieldStatsMeta;
    if (fieldstat) wrapFn(fieldstat, 'getStorageEstimation', 'storage.estimateImpl');

    wrapFn(mods.WAWebBackendApi, 'frontendSendAndReceive', 'backend.sendAndReceive', function (args) {
      return { method: typeof args[0] === 'string' ? args[0] : typeof args[0] };
    });
    wrapFn(mods.WAWebBackendApi, 'frontendFireAndForget', 'backend.fireAndForget', function (args) {
      return { method: typeof args[0] === 'string' ? args[0] : typeof args[0] };
    });

    var RDR = mods.RequireDeferredReference;
    if (RDR && RDR.prototype && !RDR.prototype.__waLoadWrapped) {
      var origLoad = RDR.prototype.load;
      if (typeof origLoad === 'function') {
        RDR.prototype.load = function () {
          var id = this.getModuleId ? String(this.getModuleId()) : '?';
          rec('rd.load', id);
          var out = origLoad.apply(this, arguments);
          if (out && typeof out.then === 'function') {
            return out.then(
              function (v) { rec('rd.load:ok', id); return v; },
              function (e) { err('rd.load ' + id, e); throw e; },
            );
          }
          rec('rd.load:sync', id);
          return out;
        };
      }
      RDR.prototype.__waLoadWrapped = true;
      diag.patches.push('RequireDeferredReference.load');
    }
    wrapFn(mods.WAWebClientPayloadReleaseChannel, 'getReleaseChannel', 'payload.releaseChannel');

    var router = mods.WADynamicRouterAsync && mods.WADynamicRouterAsync.DynamicRouter;
    if (router && router.prototype && !router.prototype.__waRouterWrapped) {
      ['setNamespaceHandler', 'setHandlers', 'sendAndReceive', 'fireAndForget'].forEach(function (name) {
        var orig = router.prototype[name];
        if (typeof orig !== 'function') return;
        router.prototype[name] = function () {
          var arg = arguments[0];
          rec('router.' + name, {
            ns: typeof arg === 'string' ? arg : null,
            route: typeof arguments[1] === 'string' ? arguments[1] : null,
          });
          var out = orig.apply(this, arguments);
          if (out && typeof out.then === 'function') {
            return out.then(
              function (v) { rec('router.' + name + ':ok', null); return v; },
              function (e) { err('router.' + name, e); throw e; },
            );
          }
          rec('router.' + name + ':sync', null);
          return out;
        };
      });
      router.prototype.__waRouterWrapped = true;
      diag.patches.push('router');
    }
    var origSetApi = mods.WAWebBackendApi && mods.WAWebBackendApi.setApi;
    if (typeof origSetApi === 'function' && !origSetApi.__waWrapped) {
      mods.WAWebBackendApi.setApi = function (api) {
        rec('backend.setApi:enter', null);
        try {
          if (api && typeof api.sendAndReceive === 'function' && !api.__waWrapped) {
            var origSR = api.sendAndReceive;
            api.sendAndReceive = function (ns, route) {
              rec('router.sendAndReceive', {
                ns: typeof ns === 'string' ? ns : null,
                route: typeof route === 'string' ? route : null,
              });
              var out = origSR.apply(this, arguments);
              if (out && typeof out.then === 'function') {
                return out.then(
                  function (v) { rec('router.sendAndReceive:ok', null); return v; },
                  function (e) { err('router.sendAndReceive', e); throw e; },
                );
              }
              rec('router.sendAndReceive:sync', null);
              return out;
            };
            var origSH = api.setHandlers;
            if (typeof origSH === 'function') {
              api.setHandlers = function (ns) {
                rec('router.setHandlers', typeof ns === 'string' ? ns : null);
                return origSH.apply(this, arguments);
              };
            }
            var origSN = api.setNamespaceHandler;
            if (typeof origSN === 'function') {
              api.setNamespaceHandler = function (ns) {
                rec('router.setNamespaceHandler', typeof ns === 'string' ? ns : null);
                return origSN.apply(this, arguments);
              };
            }
            api.__waWrapped = true;
          }
        } catch (e) {
          err('wrap router instance', e);
        }
        var out = origSetApi.apply(this, arguments);
        window.__waBridge = api;
        rec('backend.setApi:ok', null);
        return out;
      };
      mods.WAWebBackendApi.setApi.__waWrapped = true;
      diag.patches.push('backend.setApi.instance');
    }

    // Did the deferred handler module ever get defined/required?
    try {
      if (typeof window.__d === 'function' && !window.__d.__waWrapped) {
        var origD = window.__d;
        window.__d = function (name, deps, factory) {
          var nm = String(name);
          if (!diag.defines) diag.defines = [];
          if (diag.defines.length < 4000) diag.defines.push(nm);
          if (!__modRegistry[nm]) {
            __modRegistry[nm] = { deps: deps || [], factory: factory, exports: null };
          }
          if (/SetFrontendHandler|SetWorkerSafeHandler|CryptoHkdf/.test(nm)) {
            rec('define', nm);
            if (nm === 'WAWebSetFrontendHandlerApi') {
              diag.handlerDeps = deps;
              diag.handlerFactory = String(factory).slice(0, 12000);
              diag.handlerScript = (document.currentScript && document.currentScript.src) || null;
              diag.handlerStack = String(new Error().stack || '').slice(0, 1500);
            }
          }
          return origD.apply(this, arguments);
        };
        window.__d.__waWrapped = true;
        diag.patches.push('__d');
      }
      if (typeof window.require === 'function' && !window.require.__waWrapped) {
        var origReq = window.require;
        window.require = function (name) {
          var nm = String(name);
          if (/SetFrontendHandler|SetWorkerSafeHandler|CryptoHkdf/.test(nm)) rec('require', nm);
          try {
            var out = origReq.apply(this, arguments);
            if (/SetFrontendHandler|SetWorkerSafeHandler|CryptoHkdf/.test(nm)) rec('require:ok', nm);
            return out;
          } catch (e) {
            err('require ' + nm, e);
            throw e;
          }
        };
        window.require.__waWrapped = true;
        diag.patches.push('require');
      }
      if (typeof window.requireDeferred === 'function' && !window.requireDeferred.__waWrapped) {
        var origRD = window.requireDeferred;
        window.requireDeferred = function (name) {
          rec('requireDeferred', String(name));
          return origRD.apply(this, arguments);
        };
        window.requireDeferred.__waWrapped = true;
        diag.patches.push('requireDeferred');
      }
    } catch (e) {
      err('patch loader', e);
    }

    wrapFn(mods.WAWebNoiseInfoWorkerCompatible, 'getNoiseInfo', 'noiseInfo.get');
    wrapFn(mods.WAWebNoiseInfoWorkerCompatible, 'setCertificateChain', 'noiseInfo.setCertChain');

    var store = mods.WAWebUserPrefsInfoStore;
    if (store && store.waNoiseInfo) {
      wrapFn(store.waNoiseInfo, 'get', 'prefs.waNoiseInfo.get');
      wrapFn(store.waNoiseInfo, 'set', 'prefs.waNoiseInfo.set');
    }

    wrapFn(mods.WAWebProcessCertificate, 'verifyAndProcessCertificate', 'processCertificate');

    var FS = mods.WAFrameSocket && mods.WAFrameSocket.FrameSocket;
    if (FS && FS.prototype && !FS.prototype.__waFrameWrapped) {
      var sendFrame = FS.prototype.sendFrame;
      if (typeof sendFrame === 'function') {
        FS.prototype.sendFrame = function (frame) {
          rec('FrameSocket.sendFrame', sizeOf(frame));
          return sendFrame.apply(this, arguments);
        };
      }
      FS.prototype.__waFrameWrapped = true;
      diag.patches.push('FrameSocket.sendFrame');
    }

    return true;
  }

  // navigator.storage.estimate() is used by the device-props builder; if it
  // never settles the client payload never gets built.
  try {
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      var origEstimate = navigator.storage.estimate.bind(navigator.storage);
      navigator.storage.estimate = function () {
        rec('navigator.storage.estimate:enter', null);
        var out = origEstimate();
        if (out && typeof out.then === 'function') {
          return out.then(
            function (value) {
              rec('navigator.storage.estimate:ok', value ? value.quota : null);
              return value;
            },
            function (e) {
              err('navigator.storage.estimate', e);
              throw e;
            },
          );
        }
        rec('navigator.storage.estimate:sync', sizeOf(out));
        return out;
      };
      diag.patches.push('navigator.storage.estimate');
    }
  } catch (e) {
    err('patch navigator.storage.estimate', e);
  }

  // Capture the POST that fetches the v4 worker's dynamic data. If its body
  // lacks lsd/__hs/__spin, the edge answers 400 and the worker never inits.
  try {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    var origSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__waMethod = method;
      this.__waUrl = String(url);
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      if (this.__waUrl && this.__waUrl.indexOf('worker_module') >= 0) {
        this.__waHeaders = this.__waHeaders || {};
        this.__waHeaders[k] = String(v);
      }
      return origSet.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      // Obscura's XHR sends no Referer/Sec-Fetch-*. WhatsApp's edge answers a
      // UA-bearing request without them with 400 (worker bundle, /ajax/bz).
      try {
        var abs = new URL(this.__waUrl, location.href);
        if (abs.origin === location.origin && abs.protocol === 'https:') {
          var have = this.__waHeaders || {};
          var self = this;
          var add = function (k, v) {
            var present = Object.keys(have).some(function (x) {
              return x.toLowerCase() === k.toLowerCase();
            });
            if (!present) {
              try {
                self.setRequestHeader(k, v);
              } catch (e) {}
            }
          };
          add('Referer', location.href.split('#')[0]);
          add('Sec-Fetch-Site', 'same-origin');
          add('Sec-Fetch-Mode', 'cors');
          add('Sec-Fetch-Dest', 'empty');
          add(
            'Accept-Language',
            (navigator.languages && navigator.languages.length
              ? navigator.languages.join(',')
              : 'en-US,en') + ';q=0.9',
          );
        }
      } catch (e) {}
      if (this.__waUrl && this.__waUrl.indexOf('worker_module') >= 0) {
        rec('xhr.worker_module', {
          method: this.__waMethod,
          body: typeof body === 'string' ? body.slice(0, 700) : Object.prototype.toString.call(body),
          headers: this.__waHeaders || null,
        });
      }
      return origSend.apply(this, arguments);
    };
    diag.patches.push('xhr.worker_module');
  } catch (e) {
    err('patch xhr', e);
  }

  try {
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (String(url).indexOf('worker_module') >= 0) {
          rec('fetch.worker_module', {
            method: (init && init.method) || (input && input.method) || 'GET',
            body: init && typeof init.body === 'string' ? init.body.slice(0, 700) : (init && init.body ? Object.prototype.toString.call(init.body) : null),
            headers: init && init.headers ? JSON.stringify(init.headers).slice(0, 700) : null,
          });
        }
        return origFetch.apply(this, arguments);
      };
      diag.patches.push('fetch.worker_module');
    }
  } catch (e) {
    err('patch fetch', e);
  }

  try {
    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      err('unhandledrejection', r && (r.stack || r.message || r));
    });
    window.addEventListener('error', function (e) {
      err('window.error', (e && (e.error && (e.error.stack || e.error.message) || e.message)) || 'error');
    });
    diag.patches.push('rejection-listeners');
  } catch (e) {
    err('install rejection listeners', e);
  }

  // The Bootloader never resolves the deferred bridge module in Obscura even
  // after its chunk defines it. Require the real aggregator and install it on
  // the real bridge as soon as both exist. This uses the genuine
  // DeviceInfoBridgeApi, not a fake payload.
  function requireLocal(name) {
    if (name === 'Promise') return Promise;
    if (typeof name === 'string' && name.indexOf('cr:') === 0) {
      try {
        return window.require(name);
      } catch (e) {
        return null;
      }
    }
    var entry = __modRegistry[name];
    if (!entry) {
      try {
        return window.require(name);
      } catch (e) {
        return null;
      }
    }
    if (entry.exports) return entry.exports;
    var exportsObj = {};
    entry.exports = exportsObj;
    var req = function (n) {
      return requireLocal(n);
    };
    var moduleObj = { exports: exportsObj };
    try {
      if (entry.factory.length >= 7) {
        entry.factory.call(null, req, req, req, req, null, moduleObj, exportsObj);
      } else {
        entry.factory.call(null, req, req, req, req, null, exportsObj);
      }
    } catch (e) {
      entry.exports = null;
      throw e;
    }
    var finalExports = moduleObj.exports || exportsObj;
    entry.exports = finalExports;
    return finalExports;
  }

  var __deviceInfoInstalled = false;
  function installDeviceInfoHandler() {
    if (__deviceInfoInstalled || !window.__waBridge) return;
    try {
      var di = requireLocal('WAWebDeviceInfoBridgeApi');
      if (!di || !di.DeviceInfoBridgeApi) return;
      window.__waBridge.setHandlers('event', {
        getDeviceInfo: di.DeviceInfoBridgeApi.getDeviceInfo,
      });
      __deviceInfoInstalled = true;
      rec('bridge.deviceInfo', 'installed');
      diag.patches.push('deviceInfo-bridge');
    } catch (e) {
      var msg = String(e && (e.message || e));
      if (diag.deviceInfoError !== msg) {
        diag.deviceInfoError = msg;
        rec('bridge.deviceInfo:retry', msg);
      }
    }
  }

  setInterval(function () {
    try {
      installDeviceInfoHandler();
    } catch (e) {
      err('bridge.deviceInfo', e);
    }
  }, 250);

  var timer = setInterval(function () {
    try {
      if (patchAll()) {
        clearInterval(timer);
        rec('patched', diag.patches.slice());
      }
    } catch (e) {
      err('patchAll', e);
    }
  }, 20);
})();
