// @ts-check
// Loaded INTO the OpenCode Desktop Electron main process by launch.mjs (via
// the devtools inspector + createRequire). Attaches a self-contained
// wallpaper renderer to the app renderer (oc://renderer) and live-reloads
// settings from cli.json. No app-bundle files are modified; everything lives
// in this process for as long as it runs.

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { MAX_IMAGE_BYTES, readSettings, resolveSettings, imageMime } = require("./config.cjs")

const STATE_KEY = Symbol.for("bee-gee.desktop")
const DEBOUNCE_MS = 150

/**
 * Minimal shapes of the Electron API surface used here (no electron
 * dependency — this file must also load under plain node for tests/tsc).
 * @typedef {object} ElectronApp
 * @property {() => boolean} hasSingleInstanceLock
 * @property {(event: string, listener: (...args: any[]) => void) => void} on
 * @property {(event: string, listener: (...args: any[]) => void) => void} once
 * @property {(event: string, listener: (...args: any[]) => void) => void} removeListener
 *
 * @typedef {object} ElectronWebContents
 * @property {() => string} getURL
 * @property {() => boolean} isLoading
 * @property {() => boolean} isDestroyed
 * @property {(event: string, listener: (...args: any[]) => void) => void} on
 * @property {(event: string, listener: (...args: any[]) => void) => void} once
 * @property {(event: string, listener: (...args: any[]) => void) => void} removeListener
 * @property {(code: string, userGesture?: boolean) => Promise<any>} executeJavaScript
 *
 * @typedef {object} ModeSettings
 * @property {number} brightness
 * @property {number} opacity
 * @property {number} panelOpacity
 *
 * @typedef {object} Settings
 * @property {boolean} enabled
 * @property {string | undefined} image
 * @property {boolean} pixelated
 * @property {ModeSettings} dark
 * @property {ModeSettings} light
 *
 * @typedef {object} InjectorState
 * @property {ElectronApp} app
 * @property {(message: string) => void} log
 * @property {(fn: (...args: any[]) => void) => (...args: any[]) => void} safe
 * @property {string} configDir
 * @property {string | undefined} bundledImage
 * @property {Settings} settings
 * @property {{ key: string, mime: string, base64: string } | null} image
 * @property {string} imageKey
 * @property {string} imageWatchPath
 * @property {Map<ElectronWebContents, { domReady: (...args: any[]) => void, destroyed: (...args: any[]) => void }>} attached
 * @property {fs.FSWatcher | null} configWatcher
 * @property {fs.FSWatcher | null} imageWatcher
 * @property {NodeJS.Timeout | null} timer
 * @property {((...args: any[]) => void) | null} onCreated
 * @property {boolean} disposed
 */

/** @param {unknown} err */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Append one ISO-timestamped line to the log file. Never throws — a broken
 * logger must not take down the app main process.
 * @param {string} logFile
 * @returns {(message: string) => void}
 */
function createLogger(logFile) {
  return (message) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // logging must never throw
    }
  }
}

/**
 * True only for the OpenCode renderer itself: the packaged app loads from
 * `oc://renderer/`, the dev build from the ELECTRON_RENDERER_URL origin.
 * Anything else (embedded browser panes, devtools) is never injected.
 * @param {string} url
 * @returns {boolean}
 */
function isAppRenderer(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "oc:" && parsed.host === "renderer") return true
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (typeof devUrl === "string" && devUrl.length > 0) {
      return parsed.origin === new URL(devUrl).origin
    }
    return false
  } catch {
    return false
  }
}

/**
 * Build the wallpaper stylesheet for one apply. Self-contained — serialized
 * with .toString() into the renderer. Image treatments stay on ::before;
 * neither the wallpaper colors nor the foreground UI are inverted.
 * @param {{ enabled: boolean, pixelated: boolean, image: { key: string, mime: string, base64: string } | null, dark: ModeSettings, light: ModeSettings }} p
 * @param {string} url blob URL of the image
 * @returns {string}
 */
function wallpaperCss(p, url) {
  const fmt = (/** @type {number} */ n) => String(Math.round(n * 1000) / 1000)
  const modeVars = (/** @type {"dark" | "light"} */ mode) => {
    const s = p[mode]
    return `  --bee-gee-panel: ${fmt(s.panelOpacity * 100)}%;
  --bee-gee-scrim: rgb(0 0 0 / ${fmt(1 - s.brightness)});
  --bee-gee-fade: color-mix(in srgb, var(--bee-gee-deep) ${fmt((1 - s.opacity) * 100)}%, transparent);`
  }

  // A wallpaper canvas and a reading surface need different backing in
  // light mode. Keep home/chat canvases exposed; back their content locally.
  const lightSurfaces = (/** @type {string} */ selector) => `${selector} header {
  background-color: var(--bee-gee-deep);
}
${selector} [data-component="new-session"],
${selector} [data-slot="session-chat-panel"] > :is(.bg-v2-background-bg-base, .bg-background-stronger),
${selector} [data-component="session-composer-dock"],
${selector} [data-component="session-prompt-dock"] {
  background-color: transparent;
}
${selector} [data-component="new-session"] :has(> [data-component="new-session-wordmark"]) {
  background-color: var(--v2-background-bg-base);
  border-radius: 16px;
  padding: 24px;
}
${selector} :is([data-slot="session-turn-assistant-content"], [data-slot="session-turn-thinking"], [data-slot="session-turn-retry"]):not(:empty) {
  background-color: var(--v2-background-bg-base);
  border-radius: 12px;
  padding: 10px 14px;
  width: fit-content;
  max-width: 100%;
}
${selector} [data-slot="user-message-copy-wrapper"] {
  background-color: var(--v2-background-bg-base);
  border-radius: 6px;
  padding: 2px 6px;
  width: fit-content;
  max-width: 100%;
  --text-weak: var(--v2-text-text-muted);
  --color-text-weak: var(--v2-text-text-muted);
}
${selector} body {
  --v2-text-text-faint: var(--v2-text-text-muted);
  --color-v2-text-text-faint: var(--v2-text-text-muted);
}`

  // Resolve theme aliases on html before body overrides the original
  // tokens. Inherited aliases then track theme changes without cycles.
  const pixelated = p.pixelated ? "\n  image-rendering: pixelated;" : ""
  return `html[data-bee-gee] {
  --bee-gee-deep: var(--v2-background-bg-deep, var(--background-base));
  --bee-gee-base: var(--v2-background-bg-base, var(--background-base));
  --bee-gee-legacy-base: var(--background-base);
  --bee-gee-legacy-weak: var(--background-weak);
  --bee-gee-legacy-stronger: var(--background-stronger);
  background-color: var(--bee-gee-deep) !important;
  background-image: none !important;
${modeVars("dark")}
}
html[data-bee-gee][data-color-scheme="light"] {
${modeVars("light")}
}
html[data-bee-gee]::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-image:
    linear-gradient(var(--bee-gee-fade), var(--bee-gee-fade)),
    linear-gradient(var(--bee-gee-scrim), var(--bee-gee-scrim)),
    url(${JSON.stringify(url)});
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;${pixelated}
}
html[data-bee-gee] body {
  background: transparent !important;
  --v2-background-bg-deep: transparent;
  --color-v2-background-bg-deep: transparent;
  --v2-background-bg-base: color-mix(in srgb, var(--bee-gee-base) var(--bee-gee-panel), transparent);
  --color-v2-background-bg-base: color-mix(in srgb, var(--bee-gee-base) var(--bee-gee-panel), transparent);
  --background-base: color-mix(in srgb, var(--bee-gee-legacy-base) var(--bee-gee-panel), transparent);
  --color-background-base: color-mix(in srgb, var(--bee-gee-legacy-base) var(--bee-gee-panel), transparent);
  --background-weak: color-mix(in srgb, var(--bee-gee-legacy-weak) var(--bee-gee-panel), transparent);
  --color-background-weak: color-mix(in srgb, var(--bee-gee-legacy-weak) var(--bee-gee-panel), transparent);
  --background-stronger: color-mix(in srgb, var(--bee-gee-legacy-stronger) var(--bee-gee-panel), transparent);
  --color-background-stronger: color-mix(in srgb, var(--bee-gee-legacy-stronger) var(--bee-gee-panel), transparent);
}
${lightSurfaces('html[data-bee-gee][data-color-scheme="light"]')}
@media (prefers-color-scheme: light) {
  html[data-bee-gee]:not([data-color-scheme]) {
${modeVars("light")}
  }
${lightSurfaces("html[data-bee-gee]:not([data-color-scheme])")}
}`
}

/**
 * Runs INSIDE the renderer via webContents.executeJavaScript — serialized
 * with .toString(), so it must stay fully self-contained (helpers arrive as
 * parameters). Applies/removes the wallpaper <style> and keeps per-window
 * state on window.__beeGeeDesktop; the blob URL is cached by image key.
 * @param {{ enabled: boolean, pixelated: boolean, image: { key: string, mime: string, base64: string } | null, dark: ModeSettings, light: ModeSettings }} p
 * @param {typeof wallpaperCss} wallpaperCss
 * @returns {Promise<"on" | "off">}
 */
async function renderWallpaper(p, wallpaperCss) {
  const STYLE_ID = "bee-gee-desktop-style"
  const win = /** @type {any} */ (globalThis)
  const doc = win.document
  const state = win.__beeGeeDesktop || (win.__beeGeeDesktop = { key: null, url: null, seq: 0 })
  const seq = ++state.seq

  const teardown = () => {
    doc.getElementById(STYLE_ID)?.remove()
    delete doc.documentElement.dataset.beeGee
    if (state.url) win.URL.revokeObjectURL(state.url)
    state.url = null
    state.key = null
  }

  if (!p.enabled || !p.image) {
    teardown()
    return "off"
  }

  if (state.key !== p.image.key || !state.url) {
    const blob = await (await win.fetch(`data:${p.image.mime};base64,${p.image.base64}`)).blob()
    const url = win.URL.createObjectURL(blob)
    if (seq !== state.seq) {
      // A newer apply started while the image decoded; discard this one.
      win.URL.revokeObjectURL(url)
      return "on"
    }
    if (state.url) win.URL.revokeObjectURL(state.url)
    state.url = url
    state.key = p.image.key
  }

  let style = doc.getElementById(STYLE_ID)
  if (!style) {
    style = doc.createElement("style")
    style.id = STYLE_ID
  }
  style.textContent = wallpaperCss(p, state.url)
  // Re-append every apply so the style stays the LAST child of <head> and
  // wins over anything the app inserts later.
  doc.head.appendChild(style)
  doc.documentElement.dataset.beeGee = ""
  return "on"
}

/**
 * Send the current payload to one renderer. Never throws synchronously; the
 * evaluate promise rejection is logged.
 * @param {InjectorState} state
 * @param {ElectronWebContents} wc
 */
function apply(state, wc) {
  const s = state.settings
  const payload = {
    enabled: s.enabled,
    pixelated: s.pixelated,
    image: state.image,
    dark: s.dark,
    light: s.light,
  }
  wc.executeJavaScript(
    `(${renderWallpaper.toString()})(${JSON.stringify(payload)}, ${wallpaperCss.toString()})`,
    true,
  ).catch((err) => state.log(`apply failed: ${errMsg(err)}`))
}

/**
 * @param {InjectorState} state
 * @param {ElectronWebContents} wc
 */
function detach(state, wc) {
  const listeners = state.attached.get(wc)
  if (!listeners) return
  state.attached.delete(wc)
  try {
    wc.removeListener("dom-ready", listeners.domReady)
  } catch {
    // contents already gone
  }
  try {
    wc.removeListener("destroyed", listeners.destroyed)
  } catch {
    // contents already gone
  }
}

/**
 * Track one webContents: apply on every dom-ready whose URL is the app
 * renderer (covers reloads and fresh windows), apply immediately if the
 * renderer is already loaded, and drop tracking when it is destroyed.
 * @param {InjectorState} state
 * @param {ElectronWebContents} wc
 */
function attach(state, wc) {
  if (state.attached.has(wc) || wc.isDestroyed()) return
  const domReady = state.safe(() => {
    if (isAppRenderer(wc.getURL())) apply(state, wc)
  })
  const destroyed = state.safe(() => detach(state, wc))
  state.attached.set(wc, { domReady, destroyed })
  wc.on("dom-ready", domReady)
  wc.once("destroyed", destroyed)
  if (!wc.isLoading() && isAppRenderer(wc.getURL())) apply(state, wc)
}

/**
 * Re-apply to every attached app renderer.
 * @param {InjectorState} state
 */
function broadcast(state) {
  for (const wc of state.attached.keys()) {
    state.safe(() => {
      if (!wc.isDestroyed() && isAppRenderer(wc.getURL())) apply(state, wc)
    })()
  }
}

/**
 * Read the image file for the current settings. Stat gate first (unknown
 * mime, unreadable, or over MAX_IMAGE_BYTES -> image null); bytes are
 * re-read only when the `${path}:${mtimeMs}:${size}` cache key changes.
 * @param {InjectorState} state
 */
function loadImage(state) {
  const imagePath = state.settings.image
  if (!imagePath) {
    state.image = null
    state.imageKey = ""
    return
  }
  const mime = imageMime(imagePath)
  if (!mime) {
    state.log(`image ignored (unsupported type): ${imagePath}`)
    state.image = null
    state.imageKey = ""
    return
  }
  /** @type {fs.Stats | null} */
  let stat = null
  try {
    stat = fs.statSync(imagePath)
  } catch (err) {
    state.log(`image unreadable: ${imagePath} (${errMsg(err)})`)
  }
  if (stat && stat.size > MAX_IMAGE_BYTES) {
    state.log(`image ignored (over ${MAX_IMAGE_BYTES} bytes): ${imagePath}`)
    stat = null
  }
  if (!stat) {
    state.image = null
    state.imageKey = ""
    return
  }
  const key = `${imagePath}:${stat.mtimeMs}:${stat.size}`
  if (key === state.imageKey) return
  try {
    state.image = { key, mime, base64: fs.readFileSync(imagePath).toString("base64") }
    state.imageKey = key
  } catch (err) {
    state.log(`image read failed: ${imagePath} (${errMsg(err)})`)
    state.image = null
    state.imageKey = ""
  }
}

/**
 * Watch one directory for changes to a single file. cli.json is written
 * atomically (temp + rename), so the directory — not the file — is watched.
 * A null filename can't be attributed, so it counts as relevant. Missing
 * dirs and watcher errors are logged, never thrown.
 * @param {InjectorState} state
 * @param {string} dir
 * @param {string} basename
 * @returns {fs.FSWatcher | null}
 */
function watchFileDir(state, dir, basename) {
  /** @type {fs.FSWatcher} */
  let watcher
  try {
    watcher = fs.watch(dir, { persistent: false }, (event, filename) => {
      state.safe(() => {
        if (filename != null && filename !== basename) return
        schedule(state)
      })()
    })
  } catch (err) {
    state.log(`watch failed: ${dir} (${errMsg(err)})`)
    return null
  }
  watcher.on(
    "error",
    state.safe((err) => state.log(`watch error: ${dir} (${errMsg(err)})`)),
  )
  return watcher
}

/**
 * Keep the image watcher pointed at dirname(settings.image); re-created when
 * the image path changes, closed when there is none.
 * @param {InjectorState} state
 */
function syncImageWatcher(state) {
  const imagePath = state.settings.image ?? ""
  if (imagePath === state.imageWatchPath) return
  if (state.imageWatcher) {
    try {
      state.imageWatcher.close()
    } catch {
      // already closed
    }
    state.imageWatcher = null
  }
  state.imageWatchPath = imagePath
  if (imagePath) {
    state.imageWatcher = watchFileDir(state, path.dirname(imagePath), path.basename(imagePath))
  }
}

/**
 * Reload settings (parse errors keep the last good settings) and the image,
 * then re-point the image watcher.
 * @param {InjectorState} state
 */
function reload(state) {
  try {
    state.settings = readSettings({ configDir: state.configDir, home: os.homedir(), bundledImage: state.bundledImage })
  } catch (err) {
    state.log(`settings reload failed, keeping last good: ${errMsg(err)}`)
  }
  loadImage(state)
  syncImageWatcher(state)
}

/**
 * Debounced reload + broadcast after a watched file changes.
 * @param {InjectorState} state
 */
function schedule(state) {
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(
    state.safe(() => {
      reload(state)
      broadcast(state)
    }),
    DEBOUNCE_MS,
  )
  state.timer.unref?.()
}

/**
 * Remove every listener/watcher/timer this install created.
 * @param {InjectorState} state
 */
function dispose(state) {
  if (!state || state.disposed) return
  state.disposed = true
  if (state.timer) clearTimeout(state.timer)
  for (const watcher of [state.configWatcher, state.imageWatcher]) {
    if (watcher) {
      try {
        watcher.close()
      } catch {
        // already closed
      }
    }
  }
  if (state.onCreated) {
    try {
      state.app.removeListener("web-contents-created", state.onCreated)
    } catch {
      // app already tearing down
    }
  }
  for (const wc of [...state.attached.keys()]) detach(state, wc)
}

/**
 * Install (or reinstall) the injector inside the Electron main process.
 * Idempotent: a previous install under the same global key is fully disposed
 * first, so re-running the launcher picks up new code and settings cleanly.
 * @param {{ configDir: string, bundledImage?: string, logFile: string }} input
 * @returns {{ pid: number, electron: string | undefined, locked: boolean, attached: number }}
 */
function install(input) {
  const g = /** @type {any} */ (globalThis)
  // Lazy require: this module must also load under plain node (tests, tsc).
  // @ts-ignore - "electron" only resolves inside the app main process
  const { app, webContents } = require("electron")

  const prev = g[STATE_KEY]
  if (prev) dispose(prev)

  const log = createLogger(input.logFile)

  /** @type {InjectorState} */
  const state = {
    app,
    log,
    // Every Electron callback body goes through this boundary: an uncaught
    // exception in the main process surfaces as an error dialog in the app.
    safe:
      (fn) =>
      (...args) => {
        try {
          fn(...args)
        } catch (err) {
          log(`callback error: ${errMsg(err)}`)
        }
      },
    configDir: input.configDir,
    bundledImage: input.bundledImage,
    // Defaults until the first successful cli.json read.
    settings: resolveSettings({
      options: undefined,
      configDir: input.configDir,
      home: os.homedir(),
      bundledImage: input.bundledImage,
    }),
    image: null,
    imageKey: "",
    imageWatchPath: "",
    attached: new Map(),
    configWatcher: null,
    imageWatcher: null,
    timer: null,
    onCreated: null,
    disposed: false,
  }
  g[STATE_KEY] = state

  log(`install: pid=${process.pid} electron=${process.versions.electron}`)
  reload(state)

  const onCreated = state.safe((_event, /** @type {ElectronWebContents} */ wc) => attach(state, wc))
  state.onCreated = onCreated
  app.on("web-contents-created", onCreated)
  for (const wc of /** @type {ElectronWebContents[]} */ (webContents.getAllWebContents())) {
    state.safe(() => attach(state, wc))()
  }

  state.configWatcher = watchFileDir(state, input.configDir, "cli.json")
  app.once(
    "will-quit",
    state.safe(() => dispose(state)),
  )

  return {
    pid: process.pid,
    electron: process.versions.electron,
    locked: app.hasSingleInstanceLock(),
    attached: state.attached.size,
  }
}

module.exports = { install, wallpaperCss }
