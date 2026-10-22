// A virtual clock for the fake ComfyUI pages in this suite.
//
// The bridge schedules three kinds of timer: a ~400 ms poll tick, a ~600 ms settle window after a write,
// and — since round 7 — a 25 s watchdog per command plus a 150 ms frame wait inside a save. Harnesses
// that "fire one timer per command" in arrival order therefore either never reach the reply (the poll
// tick was not the one popped) or fire the watchdog early and make every command look stalled. Firing in
// due order reproduces what a browser does: the 400 ms tick always runs before the 25 s deadline, so a
// command that answers normally is answered before the watchdog is even due.
//
// Usage in a sandbox context: `setTimeout: timers.schedule, clearTimeout: timers.unschedule`, and in the
// command helper: `await timers.runUntil(() => replies.length > before)`.

export function createPageTimers(options = {}) {
  const flush = options.flush || (async () => { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)); });
  const queue = [];
  let clock = 0, seq = 0;
  const api = {
    queue,
    get clock() { return clock; },
    schedule(fn, ms) { const entry = { fn, at: clock + (Number(ms) || 0), seq: seq++ }; queue.push(entry); return entry; },
    unschedule(entry) { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); return index >= 0; },
    runNext() {
      if (!queue.length) return false;
      const next = queue.reduce((earliest, item) => (item.at < earliest.at || (item.at === earliest.at && item.seq < earliest.seq) ? item : earliest));
      api.unschedule(next);
      clock = Math.max(clock, next.at);
      next.fn();
      return true;
    },
    async runUntil(done, limit = 400) {
      for (let turn = 0; turn < limit && !done(); turn += 1) {
        if (!api.runNext()) { await flush(); continue; }
        await flush();
      }
      return done();
    },
    async drain(limit = 200) { for (let i = 0; i < limit && queue.length; i += 1) { api.runNext(); await flush(); } }
  };
  return api;
}
