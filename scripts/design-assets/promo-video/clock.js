// The video's own clock, loaded before anything else on the page. Time on the
// page stands still until video.mjs moves it: performance.now, Date.now,
// timers and animation frames all read this clock, Math.random is seeded, and
// every CSS animation and transition is held paused and set to the clock's
// time. A frame is therefore the same picture however long the capture takes,
// and the sea's simulation, stepped once a frame, runs the same way each time.
(function () {
  var realRaf = window.requestAnimationFrame.bind(window);
  var realNow = performance.now.bind(performance);
  var realTimeout = window.setTimeout.bind(window);
  var EPOCH = Date.UTC(2026, 10, 2, 9, 0, 0);
  var now = 0;
  var frames = [];
  var frameId = 0;
  var timers = new Map();
  var timerId = 0;
  var seed = 0x2f6b1d;

  performance.now = function () { return now; };
  Date.now = function () { return EPOCH + Math.round(now); };
  Math.random = function () { return (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296; };
  window.requestAnimationFrame = function (callback) {
    frameId += 1;
    frames.push({ id: frameId, callback: callback });
    return frameId;
  };
  window.cancelAnimationFrame = function (id) {
    frames = frames.filter(function (entry) { return entry.id !== id; });
  };
  function addTimer(callback, ms, args, every) {
    timerId += 1;
    timers.set(timerId, { at: now + Math.max(0, Number(ms) || 0), callback: callback, args: args, every: every ? Math.max(1, Number(ms) || 0) : 0 });
    return timerId;
  }
  window.setTimeout = function (callback, ms) { return addTimer(callback, ms, [].slice.call(arguments, 2), false); };
  window.setInterval = function (callback, ms) { return addTimer(callback, ms, [].slice.call(arguments, 2), true); };
  window.clearTimeout = window.clearInterval = function (id) { timers.delete(id); };

  // When each animation was first seen, on this clock; animations CSS keeps paused are left alone.
  var started = new WeakMap();
  var cssPaused = new WeakSet();

  window.__clock = {
    get now() { return now; },
    /** Moves the clock to `ms`, firing the timers due on the way. */
    advanceTo: function (ms) {
      for (;;) {
        var dueId = 0, due = null;
        timers.forEach(function (timer, id) {
          if (timer.at <= ms && (!due || timer.at < due.at)) { due = timer; dueId = id; }
        });
        if (!due) break;
        now = Math.max(now, due.at);
        if (due.every) due.at += due.every;
        else timers.delete(dueId);
        due.callback.apply(window, due.args);
      }
      now = Math.max(now, ms);
    },
    /** Runs the animation frames asked for since the last one. */
    flushFrames: function () {
      var queue = frames;
      frames = [];
      queue.forEach(function (entry) { entry.callback(now); });
    },
    /** Sets every CSS animation and transition to the clock's time. */
    syncAnimations: function () {
      document.getAnimations().forEach(function (animation) {
        if (cssPaused.has(animation)) return;
        var start = started.get(animation);
        if (start === undefined) {
          if (animation.playState === 'paused') { cssPaused.add(animation); return; }
          start = now;
          started.set(animation, start);
        }
        animation.pause();
        animation.currentTime = now - start;
      });
    },
    real: { requestAnimationFrame: realRaf, now: realNow, setTimeout: realTimeout },
  };
})();
