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

function layoutCanvas() {
  var W = window.innerWidth, H = window.innerHeight;
  var bw = canvasEl.width, bh = canvasEl.height;      // read live: follows the game if it resizes itself
  if (!bw || !bh) return;
  var s = Math.min(W / bw, H / bh);
  var cw = Math.round(bw * s), ch = Math.round(bh * s);
  canvasEl.style.width = cw + 'px';
  canvasEl.style.height = ch + 'px';
  canvasEl.style.left = Math.round((W - cw) / 2) + 'px';
  canvasEl.style.top = Math.round((H - ch) / 2) + 'px';
}

function tryStart() {
  if (started || !loveReady || needsRotate()) return;
  canvasEl.width = window.innerWidth;                 // the one and only buffer sizing
  canvasEl.height = window.innerHeight;
  started = true;
  layoutCanvas();
  Love(Module);
}

function onViewportChange() {
  sizeLoadingCanvas();
  if (!started) tryStart();
  else if (!needsRotate()) layoutCanvas();
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

// ---- Service worker (offline + installability) ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      console.warn('Service worker registration failed:', err);
    });
  });
}
