/**
 * Page-side driver for spike/21. Fire-and-forget: everything lands on
 * window.__t so the host can poll it without holding the CDP session.
 */
(function () {
  window.__t = { echo: { events: [] }, wa: { events: [] }, done: false };

  window.__startWsGate = function () {
    var t = window.__t;

    var echo = new WebSocket(window.__ECHO_URL || 'wss://ws.postman-echo.com/raw');
    echo.binaryType = 'arraybuffer';
    echo.onopen = function () {
      t.echo.events.push('open');
      echo.send('obscura-tunnel');
    };
    echo.onmessage = function (ev) {
      t.echo.gotReply = true;
      t.echo.replyLen = ev.data instanceof ArrayBuffer ? ev.data.byteLength : String(ev.data).length;
      t.echo.events.push('message');
      echo.close();
    };
    echo.onerror = function (e) {
      t.echo.events.push('error:' + ((e && e.message) || ''));
    };
    echo.onclose = function (e) {
      t.echo.events.push('close:' + e.code);
      maybeDone();
    };
    setTimeout(function () {
      if (!t.echo.gotReply) t.echo.timedOut = true;
      maybeDone();
    }, 20000);

    var wa = new WebSocket('wss://web.whatsapp.com/ws/chat');
    wa.binaryType = 'arraybuffer';
    wa.onopen = function () {
      t.wa.events.push('open');
      var probe = new Uint8Array([0x57, 0x41, 0x01, 0x00]);
      try {
        wa.send(probe);
        t.wa.sent = true;
      } catch (e) {
        t.wa.sendError = String((e && e.message) || e);
      }
    };
    wa.onmessage = function () {
      t.wa.events.push('message');
    };
    wa.onerror = function () {
      t.wa.events.push('error');
    };
    wa.onclose = function (e) {
      t.wa.events.push('close:' + e.code);
    };
    setTimeout(function () {
      t.wa.finished = true;
      maybeDone();
    }, 10000);

    function maybeDone() {
      if (t.echo.gotReply || t.echo.timedOut) {
        if (t.wa.sent || t.wa.finished || t.wa.events.length) {
          t.done = true;
        }
      }
    }
    setTimeout(function () {
      t.done = true;
    }, 25000);
  };
})();
