/* Balatro PWA bootstrap: splash screen, canvas sizing/start, audio unlock, wake lock, orientation,
   Emscripten Module config, service worker + auto-update, ?debug tools.
   Must load BEFORE js/loader.js and app/love.js. */

function byId(id) { return document.getElementById(id); }

// ---- Audio: mobile browsers keep AudioContexts suspended until a user gesture, and
// suspend them again when the app is backgrounded. Track every context and resume it. ----
(function () {
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  var ctxs = [];
  function Patched() {
    var c = new (Function.prototype.bind.apply(AC, [null].concat([].slice.call(arguments))))();
    ctxs.push(c);
    return c;
  }
  Patched.prototype = AC.prototype;
  window.AudioContext = Patched;
  window.webkitAudioContext = Patched;

  function resumeAll() {
    ctxs.forEach(function (c) {
      if (c.state !== 'running') { try { c.resume(); } catch (e) {} }
    });
  }
  ['touchstart', 'touchend', 'pointerup', 'mouseup', 'click', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, resumeAll, { passive: true });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') resumeAll();
  });
})();

// ---- Keep the screen awake while playing (re-acquired after backgrounding) ----
(function () {
  var lock = null;
  async function acquire() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !lock) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', function () { lock = null; });
      }
    } catch (e) { lock = null; }
  }
  ['touchend', 'pointerup', 'click'].forEach(function (ev) {
    window.addEventListener(ev, acquire, { passive: true });
  });
  document.addEventListener('visibilitychange', acquire);
})();

// ---- Landscape lock. Works on Android/Chrome (installed app or fullscreen). iOS Safari has no API
// for this at all, so there the "rotate your device" screen is all a web page can do. ----
(function () {
  var locked = false;
  function lockLandscape() {
    if (locked) return;
    try {
      var o = screen.orientation;
      if (o && o.lock) o.lock('landscape').then(function () { locked = true; }, function () {});
    } catch (e) {}
  }
  ['touchend', 'pointerup', 'click'].forEach(function (ev) {
    window.addEventListener(ev, lockLandscape, { passive: true });
  });
})();

// ---- Block iOS pinch-zoom gestures ----
['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) {
  document.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false });
});

// ---- Ask the browser not to evict our IndexedDB save data ----
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(function () {});
}

// ================= Loading screen =================
var splashEl = byId('splash');
var splashTipEl = byId('splashTip');
var TIPS = ['Shuffling the deck\u2026', 'Dealing the first hand\u2026', 'Polishing the jokers\u2026',
            'Stacking the chips\u2026', 'Checking the odds\u2026'];
var MIN_AFTER_READY_MS = 900;        // keep the splash at least this long once the engine is up
var SPLASH_FAILSAFE_MS = 45000;      // never leave it up forever
var ready = false, readyAt = 0, drawnAfterReady = false, splashHidden = false;
var tipIndex = 0;

function setProgress(p) {
  if (!splashEl) return;
  splashEl.style.setProperty('--p', Math.round(Math.max(0.04, Math.min(1, p)) * 100) + '%');
}
var tipTimer = setInterval(function () {
  if (!splashTipEl) return;
  splashTipEl.classList.add('swap');
  setTimeout(function () {
    tipIndex = (tipIndex + 1) % TIPS.length;
    splashTipEl.textContent = TIPS[tipIndex];
    splashTipEl.classList.remove('swap');
  }, 300);
}, 2000);
function hideSplash() {
  if (splashHidden || !splashEl) return;
  splashHidden = true;
  clearInterval(tipTimer);
  setProgress(1);
  splashEl.classList.add('done');
  setTimeout(function () { if (splashEl.parentNode) splashEl.parentNode.removeChild(splashEl); }, 1000);
}
function maybeHideSplash() {
  if (ready && drawnAfterReady) {
    setTimeout(hideSplash, Math.max(0, MIN_AFTER_READY_MS - (Date.now() - readyAt)));
  }
}
setTimeout(hideSplash, SPLASH_FAILSAFE_MS);

// The engine becomes "ready" right before the game's Lua code starts (which takes a few seconds on a
// phone). The splash stays until the game draws its first frame, so there's no black gap.
(function hookFirstDraw() {
  var hooked = [];
  function unhook() { hooked.forEach(function (h) { h[0][h[1]] = h[2]; }); hooked = []; }
  ['WebGLRenderingContext', 'WebGL2RenderingContext'].forEach(function (name) {
    var C = window[name];
    if (!C) return;
    ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'].forEach(function (m) {
      var P = C.prototype, orig = P[m];
      if (!orig) return;
      P[m] = function () {
        if (ready && !drawnAfterReady) { drawnAfterReady = true; unhook(); maybeHideSplash(); }
        return orig.apply(this, arguments);
      };
      hooked.push([P, m, orig]);
    });
  });
})();

// ================= Canvas sizing / start =================
// The LOVE/SDL runtime only learns about window-size changes through Module.setCanvasSize(), so
// changing the canvas buffer size after the game has started leaves it rendering to a stale
// viewport. So: the buffer size is set ONCE, right before the game starts, and from then on the
// canvas is only scaled with CSS. The game does its own aspect-ratio layout inside the canvas.
var canvasEl = byId('canvas');
var rotateQuery = window.matchMedia('(orientation: portrait) and (max-width: 900px)');  // same query as the CSS overlay
var started = false, loveReady = false;

function needsRotate() {
  // also covers iOS reporting stale sizes for a moment after rotation
  return rotateQuery.matches || (window.innerWidth < window.innerHeight && window.innerWidth <= 900);
}

// The canvas is positioned through CSS variables consumed by an !important stylesheet rule, so the
// runtime's own inline styles can never move or shrink it.
function setCanvasBox(x, y, w, h) {
  var r = document.documentElement.style;
  r.setProperty('--cx', x + 'px'); r.setProperty('--cy', y + 'px');
  r.setProperty('--cw', w + 'px'); r.setProperty('--ch', h + 'px');
}

function layoutCanvas() {
  var W = window.innerWidth, H = window.innerHeight;
  var bw = canvasEl.width, bh = canvasEl.height;      // read live: follows the game if it resizes itself
  var cw = W, ch = H, cx = 0, cy = 0;
  if (bw && bh) {
    var a = bw / bh, b = W / H;
    // Small aspect difference: letterbox (no distortion). Big difference means the buffer is not
    // trustworthy, so fill the screen instead of showing a tiny box.
    if (Math.max(a, b) / Math.min(a, b) <= 1.35) {
      var s = Math.min(W / bw, H / bh);
      cw = Math.round(bw * s); ch = Math.round(bh * s);
      cx = Math.round((W - cw) / 2); cy = Math.round((H - ch) / 2);
    }
  }
  setCanvasBox(cx, cy, cw, ch);
}

// LOVE creates its window from the *screen* size (conf.lua asks for 0x0 = desktop size). iPhones keep
// reporting portrait dimensions in landscape. Report the actual window size instead, so the game is
// created at exactly the size we show it.
function overrideScreenSize() {
  var w = window.innerWidth, h = window.innerHeight;
  [['width', w], ['height', h], ['availWidth', w], ['availHeight', h]].forEach(function (p) {
    try {
      Object.defineProperty(window.screen, p[0], { configurable: true, get: function () { return p[1]; } });
    } catch (e) {}
  });
}

function doStart() {
  overrideScreenSize();
  canvasEl.width = window.innerWidth;
  canvasEl.height = window.innerHeight;
  started = true;
  layoutCanvas();
  Love(Module);
}

// Don't start until we're in landscape AND the reported window size has stopped changing: iOS can
// report unsettled sizes for a moment right after launch or rotation, and the game is created at
// whatever size we use here for the rest of the session.
var startTimer = 0, settleChecks = 0;
function tryStart() {
  if (started || !loveReady) return;
  if (needsRotate()) { settleChecks = 0; return; }       // resize/orientation events will call us again
  if (startTimer) return;
  var before = window.innerWidth + 'x' + window.innerHeight;
  startTimer = setTimeout(function () {
    startTimer = 0;
    if (started || needsRotate()) return;
    var after = window.innerWidth + 'x' + window.innerHeight;
    if (before !== after && ++settleChecks < 15) return tryStart();   // still settling: sample again
    doStart();
  }, 350);
}

function onViewportChange() {
  if (!started) tryStart();
  else if (!needsRotate()) layoutCanvas();
  if (started) setTimeout(layoutCanvas, 250);          // catch the runtime resizing itself after a resize
}
window.addEventListener('load', onViewportChange);
if (rotateQuery.addEventListener) rotateQuery.addEventListener('change', onViewportChange);

// The LOVE/SDL runtime registers its own window 'resize' handler. It reacts to every browser resize
// (including the extra ones iOS fires after launch and after each rotation) by resizing the game's
// canvas and telling the game it has a new window size, which then disagrees with how we display it
// (squashed picture, taps landing in the wrong place). Once the game is running its size is FINAL:
// we handle all scaling with CSS. These capture-phase listeners are registered before the runtime's
// and stop the events from reaching it.
var blockedEvents = 0;
window.addEventListener('resize', function (e) {
  onViewportChange();
  if (started) { blockedEvents++; e.stopImmediatePropagation(); }
}, true);
window.addEventListener('orientationchange', function (e) {
  // iOS reports the new size a beat late after rotating
  setTimeout(onViewportChange, 100);
  setTimeout(onViewportChange, 400);
  setTimeout(onViewportChange, 900);
  if (started) { blockedEvents++; e.stopImmediatePropagation(); }
}, true);

function showFatal(message) {
  var el = byId('fatal');
  if (!el) return;
  el.querySelector('p').textContent = message;
  el.hidden = false;
}

// ================= Emscripten Module =================
var Module = {
  arguments: ['./game.love'],
  INITIAL_MEMORY: 256000000,
  // love.wasm and game.data live in /app/
  locateFile: function (path) { return 'app/' + path; },
  printErr: console.error.bind(console),
  canvas: (function () {
    canvasEl.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      // Mobile OSes can drop the GL context when the app is backgrounded; a reload is the only recovery.
      if (window.__syncSaves) { try { window.__syncSaves(); } catch (err) {} }
      showFatal('Graphics were reset by your device.');
    }, false);
    return canvasEl;
  })(),
  setStatus: function (text) {
    if (text) {
      var m = /\((\d+)\/(\d+)\)/.exec(text);
      if (m) setProgress(0.15 + 0.6 * (+m[1]) / Math.max(1, +m[2]));
      else if (/Downloading/i.test(text)) setProgress(0.1);
      else if (/complete/i.test(text)) setProgress(0.8);
      else if (/Running/i.test(text)) setProgress(0.85);
    } else if (Module.remainingDependencies === 0) {
      canvasEl.style.visibility = 'visible';
      ready = true; readyAt = Date.now();
      setProgress(0.95);
      maybeHideSplash();
    }
  },
  totalDependencies: 0,
  remainingDependencies: 0,
  monitorRunDependencies: function (left) {
    this.remainingDependencies = left;
    this.totalDependencies = Math.max(this.totalDependencies, left);
    Module.setStatus(left
      ? 'Preparing... (' + (this.totalDependencies - left) + '/' + this.totalDependencies + ')'
      : 'All downloads complete.');
  }
};
Module.setStatus('Downloading...');

window.onerror = function (msg) {
  // Only block the screen if startup itself failed; later stray errors are just logged.
  if (!ready) showFatal('Something went wrong while starting the game. Try reloading.');
  else console.warn('Page error after startup:', msg);
};

// Called by app/love.js once it has loaded. Waits for landscape so the game never starts in portrait.
function applicationLoad() {
  loveReady = true;
  tryStart();
}

// ================= Service worker + updates =================
// Goal: after you push a change, the app picks it up on the next open (or when you switch back to it).
var reloading = false;
function reloadOnce() { if (!reloading) { reloading = true; location.reload(); } }

if ('serviceWorker' in navigator) {
  var hadController = !!navigator.serviceWorker.controller;
  // A new service worker took over: reload so the page and its scripts are the new version.
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (hadController) reloadOnce();
  });
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') reg.update().catch(function () {});
      });
      reg.update().catch(function () {});
    }).catch(function (err) { console.warn('Service worker registration failed:', err); });
  });
}

// Installed iPhone/Android apps are usually resumed, not reloaded. Remember a fingerprint of each app
// file when we load, and when the app comes back to the foreground compare against the server.
var WATCH = ['index.html', 'js/boot.js', 'js/loader.js', 'app/love.js', 'manifest.webmanifest'];
var fingerprints = null;
function readFingerprints() {
  var out = {};
  return Promise.all(WATCH.map(function (f) {
    return fetch(f, { method: 'HEAD', cache: 'no-cache' }).then(function (r) {
      out[f] = r.ok ? (r.headers.get('etag') || r.headers.get('last-modified') || '') : '';
    }).catch(function () { out[f] = ''; });
  })).then(function () { return out; });
}
window.addEventListener('load', function () { readFingerprints().then(function (f) { fingerprints = f; }); });
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible' || !fingerprints) return;
  readFingerprints().then(function (now) {
    var changed = WATCH.some(function (f) { return now[f] && fingerprints[f] && now[f] !== fingerprints[f]; });
    if (changed) reloadOnce();
  });
});

// ================= ?debug tools =================
// Open the site with ?debug on the end of the address: live size read-out, a crosshair where you
// touch, and the game's actual GL viewport.
if (/[?&]debug/.test(location.search)) {
  var dbg = byId('debug'), probe = byId('probe');
  dbg.hidden = false;
  var lastVp = null, lastTouch = 'touch  (none yet)';
  ['WebGLRenderingContext', 'WebGL2RenderingContext'].forEach(function (n) {
    var C = window[n];
    if (!C) return;
    var o = C.prototype.viewport;
    C.prototype.viewport = function (x, y, w, h) {
      lastVp = [x, y, w, h, this.drawingBufferWidth, this.drawingBufferHeight];
      return o.apply(this, arguments);
    };
  });
  function onTouch(e) {
    var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!t) return;
    var r = canvasEl.getBoundingClientRect();
    probe.hidden = false;
    probe.style.left = t.clientX + 'px';
    probe.style.top = t.clientY + 'px';
    lastTouch = 'touch  client ' + Math.round(t.clientX) + ',' + Math.round(t.clientY) +
      '  in-canvas ' + Math.round(t.clientX - r.left) + ',' + Math.round(t.clientY - r.top) +
      '\n       fraction ' + ((t.clientX - r.left) / r.width).toFixed(3) + ',' + ((t.clientY - r.top) / r.height).toFixed(3);
  }
  window.addEventListener('touchstart', onTouch, { passive: true, capture: true });
  window.addEventListener('touchmove', onTouch, { passive: true, capture: true });
  setInterval(function () {
    var r = canvasEl.getBoundingClientRect(), cs = getComputedStyle(canvasEl);
    dbg.textContent =
      'window  ' + innerWidth + 'x' + innerHeight + '  dpr ' + devicePixelRatio + '\n' +
      'screen  ' + screen.width + 'x' + screen.height + '\n' +
      'buffer  ' + canvasEl.width + 'x' + canvasEl.height + '\n' +
      'css box ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' @' + Math.round(r.left) + ',' + Math.round(r.top) + '\n' +
      'pad ' + cs.padding + '  border ' + cs.borderTopWidth + '  margin ' + cs.margin + '\n' +
      'gl viewport ' + (lastVp ? lastVp.slice(0, 4).join(',') + '  drawbuf ' + lastVp[4] + 'x' + lastVp[5] : '(none yet)') + '\n' +
      'started ' + started + '  ready ' + ready + '  rotate ' + needsRotate() + '  blocked ' + blockedEvents + '\n' +
      lastTouch;
  }, 400);
}
