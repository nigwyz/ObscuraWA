// Minimal production bridge for WhatsApp Web on Obscura.
//
// The page's deferred bridge module never resolves because this build omits
// WAWebCryptoHkdf and three bridge modules. We capture the dynamic chunk's
// factories, alias the HKDF module, stub the three missing bridge modules, and
// register the genuine WAWebDeviceInfoBridgeApi on the real DynamicRouter.
//
// No diagnostics, no handshake tracing, no frame logging.
(function () {
  'use strict';
  if (window.__waBridgeInstalled) return;
  window.__waBridgeInstalled = true;

  var registry = Object.create(null);
  var errors = [];
  function note(e) {
    var text = String(e && (e.stack || e.message) || e);
    if (errors.length < 20) errors.push(text.slice(0, 400));
    window.__waBridgeErrors = errors;
  }

  function installDefineWrapper() {
    if (typeof window.require !== 'function') return false;
    if (typeof window.__d !== 'function' || window.__d.__waBridgeWrapped) return Boolean(window.__d);
    var orig = window.__d;
    window.__d = function (name, deps, factory) {
      var nm = String(name);
      if (!registry[nm]) registry[nm] = { deps: deps || [], factory: factory, exports: null };
      return orig.apply(this, arguments);
    };
    window.__d.__waBridgeWrapped = true;
    return true;
  }

  var aliasDone = false;
  function installAlias() {
    if (aliasDone || typeof window.__d !== 'function') return;
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
      aliasDone = true;
    } catch (e) {
      note(e);
    }
  }

  var stubsDone = false;
  function installStubs() {
    if (stubsDone || typeof window.__d !== 'function') return;
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
        } catch (e) {
          note(e);
        }
      })(stubs[i][0], stubs[i][1]);
    }
    stubsDone = true;
  }

  function requireLocal(name) {
    if (name === 'Promise') return Promise;
    if (typeof name === 'string' && name.indexOf('cr:') === 0) {
      try {
        return window.require(name);
      } catch (e) {
        return null;
      }
    }
    var entry = registry[name];
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

  var deviceInfoInstalled = false;
  function installDeviceInfo() {
    if (deviceInfoInstalled || !window.__waBridge) return;
    try {
      var di = requireLocal('WAWebDeviceInfoBridgeApi');
      if (!di || !di.DeviceInfoBridgeApi) return;
      window.__waBridge.setHandlers('event', {
        getDeviceInfo: di.DeviceInfoBridgeApi.getDeviceInfo,
      });
      deviceInfoInstalled = true;
      window.__waBridgeStatus = 'device-info-installed';
    } catch (e) {
      note(e);
    }
  }

  var apiDone = false;
  function wrapSetApi() {
    if (apiDone || typeof window.require !== 'function') return;
    try {
      var api = window.require('WAWebBackendApi');
      if (!api || typeof api.setApi !== 'function') return;
      var orig = api.setApi;
      api.setApi = function (bridge) {
        window.__waBridge = bridge;
        return orig.apply(this, arguments);
      };
      apiDone = true;
    } catch (e) {
      /* module not ready */
    }
  }

  setInterval(function () {
    try {
      installDefineWrapper();
      installAlias();
      installStubs();
      wrapSetApi();
      installDeviceInfo();
    } catch (e) {
      note(e);
    }
  }, 50);
})();
