# EchoEmby

[中文](README.md) · **English**

![Home](docs/images/home.png)

> Still under development

---

## Features

- Several Emby servers, account switching
- Home page recommendations, continue watching
- Details: seasons, episodes, cast, stills, genres, similar works
- Library browsing with filters and search
- Playback: hardware decoding, subtitles and audio tracks, preferred languages, chapters, speed, auto-next
- Danmaku from dandanplay
- Ratings and Chinese synopses filled in from TMDB, Rotten Tomatoes, Bangumi, Trakt and others
- Keyboard control

---

## Running it

Needs Windows, Node.js 20 or newer, and an Emby server you can reach.

```bash
npm install          # dependencies
npm run mpv          # fetch mpv.exe into resources/mpv (skipped if present)
npm run build        # compile main, preload and renderer
npm start            # launch
```

Development mode:

```bash
npm run dev
```

`npm run mpv` pulls a shinchiro mpv build from GitHub Releases. Where that host is unreachable directly, point the fetch at a proxy:

```bash
ECHOEMBY_PROXY=http://127.0.0.1:7899 npm run mpv
```

Local state lives in `%APPDATA%\EchoEmby`: encrypted credentials, settings and the metadata caches.

---

## Stack

- Electron 33, frameless window with a custom title bar
- Vue 3.5 `<script setup>` + Pinia + vue-router
- TypeScript 5.7, Vite 6 for the renderer, esbuild for main and preload
- `contextIsolation: true`, `nodeIntegration: false`; the renderer reaches the main process only through the bridge the preload exposes
- mpv as a child process: `--wid=<HWND>` embedding plus JSON IPC over a named pipe, with koffi calling user32 for window layering
- `safeStorage` (DPAPI) for credentials
- `net.fetch` in the main process is the single network egress, so the proxy setting applies in one place

```
src/
  main/        windows, mpv kernel, Emby client, metadata sources, danmaku, proxy, caches
  preload/     the bridge
  renderer/    views, components, stores, lib (fetching and formatting)
  shared/      types and protocol used by both sides
scripts/       dev, build, mpv fetch
```

---

## Notes

- This project is not affiliated with Emby.
