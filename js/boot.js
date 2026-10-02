/* Balatro PWA bootstrap: audio unlock, canvas sizing, Emscripten Module config, SW registration.
   Must load BEFORE js/loader.js and app/love.js. */

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

// ---- Block iOS pinch-zoom gestures ----
['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) {
  document.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false });
});

// ---- Ask the browser not to evict our IndexedDB save data ----
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(function () {});
}

// ---- Canvas sizing ----
// The LOVE/SDL runtime only learns about window-size changes through Module.setCanvasSize(), so
// changing the canvas buffer size after the game has started leaves it rendering to a stale
// viewport (black screen after rotating). So: the buffer size is set ONCE, right before the game
// starts, and from then on the canvas is only scaled with CSS (letterboxed, centered).
var loadingEl = document.getElementById('loadingCanvas');
var canvasEl = document.getElementById('canvas');
var rotateQuery = window.matchMedia('(orientation: portrait) and (max-width: 900px)');  // same query as the CSS overlay
var started = false, loveReady = false;

function needsRotate() {
  // also covers iOS reporting stale sizes for a moment after rotation
  return rotateQuery.matches || (window.innerWidth < window.innerHeight && window.innerWidth <= 900);
}

function sizeLoadingCanvas() {
  loadingEl.width = window.innerWidth;
  loadingEl.height = window.innerHeight;
}

// The canvas is positioned through CSS variables consumed by an !important stylesheet rule (see
// index.html), so the runtime's own inline styles can never shrink it.
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
// reporting portrait dimensions in landscape, which gave a portrait-shaped game. Report the actual
// window size instead, so the game is created at exactly the size we show it.
function overrideScreenSize() {
  var w = window.innerWidth, h = window.innerHeight;
  [['width', w], ['height', h], ['availWidth', w], ['availHeight', h]].forEach(function (p) {
    try {
      Object.defineProperty(window.screen, p[0], { configurable: true, get: function () { return p[1]; } });
    } catch (e) {}
  });
}

function tryStart() {
  if (started || !loveReady || needsRotate()) return;
  overrideScreenSize();
  canvasEl.width = window.innerWidth;
  canvasEl.height = window.innerHeight;
  started = true;
  layoutCanvas();
  Love(Module);
}

function onViewportChange() {
  sizeLoadingCanvas();
  if (!started) tryStart();
  else if (!needsRotate()) layoutCanvas();
  if (started) setTimeout(layoutCanvas, 250);          // catch the runtime resizing itself after a resize
}
window.addEventListener('resize', onViewportChange);
window.addEventListener('load', onViewportChange);
if (rotateQuery.addEventListener) rotateQuery.addEventListener('change', onViewportChange);
// iOS reports the new size a beat late after rotating
window.addEventListener('orientationchange', function () {
  setTimeout(onViewportChange, 100);
  setTimeout(onViewportChange, 400);
  setTimeout(onViewportChange, 900);
});
sizeLoadingCanvas();

var loadingContext = loadingEl.getContext('2d');
function drawLoadingText(text) {
  var canvas = loadingContext.canvas;
  loadingContext.fillStyle = 'rgb(142, 195, 227)';
  loadingContext.fillRect(0, 0, canvas.width, canvas.height);
  loadingContext.font = '2em Arial';
  loadingContext.textAlign = 'center';
  loadingContext.fillStyle = 'rgb(11, 86, 117)';
  loadingContext.fillText(text, canvas.width / 2, canvas.height / 2);
}

function showFatal(message) {
  var el = document.getElementById('fatal');
  if (!el) return;
  el.querySelector('p').textContent = message;
  el.hidden = false;
}

var Module = {
  arguments: ['./game.love'],
  INITIAL_MEMORY: 256000000,
  // love.wasm and game.data live in /app/
  locateFile: function (path) { return 'app/' + path; },
  printErr: console.error.bind(console),
  canvas: (function () {
    var canvas = document.getElementById('canvas');
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      // Mobile OSes can drop the GL context when the app is backgrounded; a reload is the only recovery.
      if (window.__syncSaves) { try { window.__syncSaves(); } catch (err) {} }
      showFatal('Graphics were reset by your device.');
    }, false);
    return canvas;
  })(),
  setStatus: function (text) {
    if (text) {
      drawLoadingText(text);
    } else if (Module.remainingDependencies === 0) {
      document.getElementById('loadingCanvas').style.display = 'none';
      document.getElementById('canvas').style.visibility = 'visible';
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

window.onerror = function () {
  Module.setStatus('Exception thrown, see console');
  Module.setStatus = function (text) {
    if (text) Module.printErr('[post-exception status] ' + text);
  };
};

// Called by app/love.js once it has loaded. Waits for landscape so the game never starts in portrait.
function applicationLoad() {
  loveReady = true;
  tryStart();
}

// ---- Service worker + updates ----
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

// ---- ?debug overlay (open the site with ?debug in the address to see sizes) ----
if (/[?&]debug/.test(location.search)) {
  var dbg = document.getElementById('debug');
  dbg.hidden = false;
  setInterval(function () {
    var r = canvasEl.getBoundingClientRect();
    dbg.textContent =
      'window  ' + innerWidth + 'x' + innerHeight + '  dpr ' + devicePixelRatio + '\n' +
      'screen  ' + screen.width + 'x' + screen.height + '\n' +
      'buffer  ' + canvasEl.width + 'x' + canvasEl.height + '\n' +
      'css box ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' @' + Math.round(r.left) + ',' + Math.round(r.top) + '\n' +
      'started ' + started + '  rotate ' + needsRotate();
  }, 400);
}
