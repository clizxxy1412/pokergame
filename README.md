# Balatro PWA

Static site, no build step. Needs **HTTPS** (or `localhost`) for the service worker / install prompt.

## Run locally
    python3 -m http.server 8000      # then open http://localhost:8000

## Deploy (any static host)
GitHub Pages, Netlify, Cloudflare Pages, Vercel, etc. No special headers needed
(the build uses no threads / SharedArrayBuffer). Subfolder hosting works: all paths are relative.

## Install
- Android / Chrome: menu -> Install app
- iOS / Safari: Share -> Add to Home Screen (then rotate to landscape)

## Layout
    index.html            shell, mobile CSS, rotate hint
    manifest.webmanifest  install metadata (fullscreen, landscape)
    sw.js                 precaches everything for offline play
    js/boot.js            Module config, canvas sizing, audio unlock, wake lock, SW registration
    js/loader.js          game.data package loader
    app/love.js           LOVE/emscripten runtime (patched: external wasm, mobile-safe save sync)
    app/love.wasm         runtime binary (was inline base64)
    app/game.data         game archive   (was inline base64)
    icons/                placeholder icons - replace with your own

## Shipping an update
Change `VERSION` in sw.js (e.g. balatro-pwa-v2). Installed copies pick it up on next launch.
