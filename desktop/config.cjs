// @ts-check
// Shared config helpers for the bee-gee desktop launcher/injector.
// CommonJS with node builtins only so the Electron main process can
// require() this file without a build step or node_modules.

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

/** Images above this size are refused; they are base64'd into the renderer. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * Strip // and block comments plus trailing commas outside strings, then
 * JSON.parse. cli.json is JSONC (opencode writes it with comments allowed).
 * @param {string} text
 * @returns {any}
 */
function parseJsonc(text) {
  let out = ""
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === "\\") {
        i++
        if (i < text.length) out += text[i]
      } else if (c === '"') {
        inString = false
      }
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    if (c === ",") {
      // Trailing comma: drop it when the next significant char closes a
      // container. String-aware scan so `,` inside a later string can't
      // confuse the lookahead (the lookahead only reads whitespace).
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === "}" || text[j] === "]") {
        i++
        continue
      }
    }
    out += c
    i++
  }
  return JSON.parse(out)
}

/**
 * opencode CLI config directory: $XDG_CONFIG_HOME/opencode, else
 * ~/.config/opencode. Same layout on every OS.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
function configDir(env = process.env, home = os.homedir()) {
  const xdg = env.XDG_CONFIG_HOME
  const base = typeof xdg === "string" && xdg.length > 0 ? xdg : path.join(home, ".config")
  return path.join(base, "opencode")
}

/**
 * True when a plugin spec points at bee-gee. Normalizes git prefixes,
 * .git/#ref suffixes, trailing separators, and a trailing @version, then
 * matches on the last path segment only — `bee-gee-extra` must not match,
 * `@scope/bee-gee` must.
 * @param {unknown} spec
 * @returns {boolean}
 */
function isBeeGeeSpec(spec) {
  if (typeof spec !== "string") return false
  let s = spec.trim()
  s = s.replace(/^(github|gitlab|bitbucket|gist):/, "")
  s = s.replace(/^git\+/, "")
  s = s.replace(/^https?:\/\//, "")
  const hash = s.indexOf("#")
  if (hash >= 0) s = s.slice(0, hash)
  s = s.replace(/\.git$/i, "")
  s = s.replace(/[/\\]+$/, "")
  // Strip a trailing @version, but keep a leading @scope segment.
  const lastSlash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"))
  const at = s.lastIndexOf("@")
  if (at > lastSlash + 1) s = s.slice(0, at)
  const segments = s.split(/[/\\]/).filter((seg) => seg.length > 0)
  const last = segments[segments.length - 1]
  return typeof last === "string" && last.toLowerCase() === "bee-gee"
}

/**
 * Find the bee-gee entry in the parsed cli.json `plugins` array and return
 * its options object ({} when the entry carries none), or undefined when no
 * entry matches / no plugins array exists.
 * Entry shapes: "spec" | { package: "spec", options?: {...} } |
 * ["spec", options].
 * @param {any} config
 * @returns {Record<string, any> | undefined}
 */
function findPluginOptions(config) {
  if (config === null || typeof config !== "object") return undefined
  const plugins = config.plugins
  if (!Array.isArray(plugins)) return undefined
  for (const entry of plugins) {
    if (typeof entry === "string") {
      if (isBeeGeeSpec(entry)) return {}
      continue
    }
    if (Array.isArray(entry)) {
      const [spec, options] = entry
      if (isBeeGeeSpec(spec)) {
        return options !== null && typeof options === "object" && !Array.isArray(options) ? options : {}
      }
      continue
    }
    if (entry !== null && typeof entry === "object" && isBeeGeeSpec(entry.package)) {
      const options = entry.options
      return options !== null && typeof options === "object" && !Array.isArray(options) ? options : {}
    }
  }
  return undefined
}

/**
 * Unit setting accepting 0-1 or 0-100 (values >1 read as percent); always
 * clamps to [0.05, 1]. Mirrors tui.tsx exactly.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function clampUnit(value, fallback) {
  const n = typeof value === "string" ? parseFloat(value) : typeof value === "number" ? value : NaN
  if (!Number.isFinite(n)) return fallback
  const fraction = n > 1 ? n / 100 : n
  return Math.min(1, Math.max(0.05, fraction))
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * @typedef {object} ModeSettings
 * @property {number} brightness
 * @property {number} opacity
 * @property {number} panelOpacity
 *
 * @typedef {object} DesktopSettings
 * @property {boolean} enabled
 * @property {string | undefined} image
 * @property {boolean} pixelated
 * @property {boolean} autoInject
 * @property {ModeSettings} dark
 * @property {ModeSettings} light
 */

const MODE_DEFAULTS = {
  dark: { brightness: 0.6, opacity: 1, panelOpacity: 0.25 },
  light: { brightness: 0.7, opacity: 1, panelOpacity: 0.95 },
}

/**
 * Per-scheme settings. Dark inherits the plugin-level
 * (TUI) brightness/opacity; light does not — those values are tuned for a
 * dark terminal.
 * @param {Record<string, any>} options
 * @param {Record<string, any>} desktop
 * @param {"dark" | "light"} mode
 * @returns {ModeSettings}
 */
function modeSettings(options, desktop, mode) {
  const scoped = isPlainObject(desktop[mode]) ? desktop[mode] : {}
  const defaults = MODE_DEFAULTS[mode]
  const plugin = mode === "dark" ? options : {}
  return {
    brightness: clampUnit(scoped.brightness ?? desktop.brightness ?? plugin.brightness, defaults.brightness),
    opacity: clampUnit(scoped.opacity ?? desktop.opacity ?? plugin.opacity, defaults.opacity),
    panelOpacity: clampUnit(scoped.panelOpacity ?? desktop.panelOpacity ?? plugin.panelOpacity, defaults.panelOpacity),
  }
}

/**
 * Resolve effective desktop settings from the bee-gee plugin options.
 * `options` may be undefined (no cli.json entry — the user ran the command
 * explicitly, so defaults apply). `desktop` is the options.desktop block
 * when it is a plain object.
 * @param {{ options?: Record<string, any>, configDir: string, home: string, bundledImage?: string }} input
 * @returns {DesktopSettings}
 */
function resolveSettings(input) {
  const options = isPlainObject(input.options) ? input.options : {}
  const desktop = isPlainObject(options.desktop) ? options.desktop : {}
  const enabled = desktop.enabled !== false

  let image
  const rawImage = typeof desktop.image === "string" && desktop.image.length > 0 ? desktop.image : options.image
  if (typeof rawImage === "string" && rawImage.length > 0) {
    if (rawImage === "~") {
      image = input.home
    } else if (rawImage.startsWith("~/") || rawImage.startsWith("~\\")) {
      image = path.join(input.home, rawImage.slice(2))
    } else if (path.isAbsolute(rawImage)) {
      image = rawImage
    } else {
      image = path.resolve(input.configDir, rawImage)
    }
  } else {
    image = input.bundledImage
  }

  return {
    enabled,
    image,
    pixelated: desktop.pixelated !== false,
    autoInject: desktop.autoInject !== false,
    dark: modeSettings(options, desktop, "dark"),
    light: modeSettings(options, desktop, "light"),
  }
}

/**
 * Read cli.json from the config dir and resolve desktop settings. A missing
 * file reads as {} (defaults). Parse errors throw with the file path in the
 * message so the injector can log a useful line.
 * @param {{ configDir: string, home: string, bundledImage?: string }} input
 * @returns {DesktopSettings}
 */
function readSettings(input) {
  const file = path.join(input.configDir, "cli.json")
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      return resolveSettings({ ...input, options: undefined })
    }
    throw err
  }
  let parsed
  try {
    parsed = parseJsonc(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to parse ${file}: ${message}`)
  }
  return resolveSettings({ ...input, options: findPluginOptions(parsed) })
}

const IMAGE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
}

/**
 * Mime type by file extension, or undefined for anything else.
 * @param {string} file
 * @returns {string | undefined}
 */
function imageMime(file) {
  return IMAGE_MIME_BY_EXT[/** @type {keyof typeof IMAGE_MIME_BY_EXT} */ (path.extname(file).toLowerCase())]
}

module.exports = {
  MAX_IMAGE_BYTES,
  parseJsonc,
  configDir,
  isBeeGeeSpec,
  findPluginOptions,
  clampUnit,
  resolveSettings,
  readSettings,
  imageMime,
}
