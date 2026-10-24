// V8's memory reducer does not reclaim idle WhatsApp garbage: a clean run
// grew from 213 MB to 251 MB PSS over 120 s (heap 73 -> 111 MB), then dropped
// to 211 MB on a forced GC. Call LowMemoryNotification on a timer instead.
export function startMemoryKeeper(cdp, { intervalMs = 30_000, delayMs = 5_000 } = {}) {
  let timer = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  };
  const start = setTimeout(() => {
    tick();
    timer = setInterval(tick, intervalMs);
    if (timer.unref) timer.unref();
  }, delayMs);
  if (start.unref) start.unref();
  return {
    stop() {
      stopped = true;
      clearTimeout(start);
      if (timer) clearInterval(timer);
    },
  };
}
