// @ts-check
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const {
  parseJsonc,
  isBeeGeeSpec,
  findPluginOptions,
  clampUnit,
  resolveSettings,
  readSettings,
  imageMime,
} = require("./config.cjs")

test("parseJsonc strips comments and trailing commas", () => {
  const parsed = parseJsonc(`{
    // line comment
    "a": 1, /* block
               comment */
    "b": [1, 2,],
    "c": "x",
  }`)
  assert.deepEqual(parsed, { a: 1, b: [1, 2], c: "x" })
})

test("parseJsonc keeps comment-like and comma text inside strings", () => {
  const parsed = parseJsonc(`{
    "url": "https://x//y",
    "glob": "a/*b*/c",
    "close": ",}",
    "esc": "say \\"hi\\" // not a comment",
  }`)
  assert.equal(parsed.url, "https://x//y")
  assert.equal(parsed.glob, "a/*b*/c")
  assert.equal(parsed.close, ",}")
  assert.equal(parsed.esc, 'say "hi" // not a comment')
})

test("parseJsonc throws on invalid input", () => {
  assert.throws(() => parseJsonc("{ nope ]"))
})

test("isBeeGeeSpec matches path-like and versioned specs", () => {
  for (const spec of [
    "bee-gee",
    "takltc/bee-gee",
    "github:takltc/bee-gee#main",
    "git+https://github.com/takltc/bee-gee.git",
    "./plugins/bee-gee/",
    "C:\\plugins\\bee-gee",
    "bee-gee@1.2.0",
    "@scope/bee-gee",
    "  takltc/bee-gee  ",
  ]) {
    assert.equal(isBeeGeeSpec(spec), true, spec)
  }
})

test("isBeeGeeSpec rejects non-bee-gee specs", () => {
  for (const spec of ["bee-gee-extra", "takltc/bee-gee-extra", "", 12, null, { package: "bee-gee" }]) {
    assert.equal(isBeeGeeSpec(spec), false, String(spec))
  }
})

test("findPluginOptions handles string, object, and tuple entries", () => {
  assert.deepEqual(findPluginOptions({ plugins: ["takltc/bee-gee"] }), {})
  assert.deepEqual(findPluginOptions({ plugins: [{ package: "x", options: { a: 1 } }, { package: "bee-gee" }] }), {})
  assert.deepEqual(findPluginOptions({ plugins: [{ package: "takltc/bee-gee", options: { brightness: 50 } }] }), {
    brightness: 50,
  })
  assert.deepEqual(findPluginOptions({ plugins: [["./plugins/bee-gee", { opacity: 0.5 }]] }), { opacity: 0.5 })
})

test("findPluginOptions returns undefined without a matching entry", () => {
  assert.equal(findPluginOptions({}), undefined)
  assert.equal(findPluginOptions({ plugins: "nope" }), undefined)
  assert.equal(findPluginOptions({ plugins: ["other/plugin", { package: "bee-gee-extra" }] }), undefined)
  assert.equal(findPluginOptions(null), undefined)
})

test("clampUnit mirrors tui.tsx semantics", () => {
  assert.equal(clampUnit(0.5, 0.6), 0.5)
  assert.equal(clampUnit(50, 0.6), 0.5)
  assert.equal(clampUnit("30", 0.6), 0.3)
  assert.equal(clampUnit(NaN, 0.6), 0.6)
  assert.equal(clampUnit("nope", 0.6), 0.6)
  assert.equal(clampUnit(0, 0.6), 0.05)
  assert.equal(clampUnit(200, 0.6), 1)
  assert.equal(clampUnit(undefined, 0.6), 0.6)
})

const CONF = "/conf"
const HOME = "/home/me"

test("resolveSettings applies defaults with no options", () => {
  const s = resolveSettings({ options: undefined, configDir: CONF, home: HOME, bundledImage: "/bundled.png" })
  assert.deepEqual(s, {
    enabled: true,
    image: "/bundled.png",
    pixelated: true,
    autoInject: true,
    dark: { brightness: 0.6, opacity: 1, panelOpacity: 0.25 },
    light: { brightness: 0.7, opacity: 1, panelOpacity: 0.95 },
  })
})

test("resolveSettings lets desktop options win over top-level options", () => {
  const s = resolveSettings({
    options: {
      image: "/top.png",
      brightness: 10,
      opacity: 20,
      desktop: {
        enabled: false,
        image: "/desk.png",
        brightness: 80,
        panelOpacity: 30,
        pixelated: false,
        autoInject: false,
      },
    },
    configDir: CONF,
    home: HOME,
    bundledImage: "/bundled.png",
  })
  assert.deepEqual(s, {
    enabled: false,
    image: "/desk.png",
    pixelated: false,
    autoInject: false,
    dark: { brightness: 0.8, opacity: 0.2, panelOpacity: 0.3 },
    light: { brightness: 0.8, opacity: 1, panelOpacity: 0.3 },
  })
})

test("resolveSettings mode blocks override shared desktop and plugin values", () => {
  const s = resolveSettings({
    options: {
      brightness: 10, // plugin-level (TUI) value: dark only
      desktop: {
        brightness: 50,
        light: { brightness: 90 },
        dark: { opacity: 40 },
      },
    },
    configDir: CONF,
    home: HOME,
  })
  // light: mode block wins over shared desktop.*; plugin-level never applies
  assert.equal(s.light.brightness, 0.9)
  // dark: mode block wins over shared desktop.* which wins over plugin
  assert.equal(s.dark.brightness, 0.5)
  assert.equal(s.dark.opacity, 0.4)
  // No light or shared opacity is set, so the light default applies.
  assert.equal(s.light.opacity, 1)
})

test("resolveSettings plugin-level brightness/opacity flow into dark but not light", () => {
  const s = resolveSettings({
    options: { brightness: 10, opacity: 20 },
    configDir: CONF,
    home: HOME,
  })
  assert.equal(s.dark.brightness, 0.1)
  assert.equal(s.dark.opacity, 0.2)
  assert.equal(s.light.brightness, 0.7)
  assert.equal(s.light.opacity, 1)
})

test("resolveSettings clamps mode-level percent values", () => {
  const s = resolveSettings({
    options: { desktop: { dark: { brightness: 70 }, light: { panelOpacity: 60 } } },
    configDir: CONF,
    home: HOME,
  })
  assert.equal(s.dark.brightness, 0.7)
  assert.equal(s.light.panelOpacity, 0.6)
})

test("resolveSettings expands ~ and resolves relative image paths against configDir", () => {
  const home = resolveSettings({
    options: { image: "~/pics/wall.png" },
    configDir: CONF,
    home: HOME,
  })
  assert.equal(home.image, path.join(HOME, "pics/wall.png"))
  const rel = resolveSettings({
    options: { desktop: { image: "wall.png" } },
    configDir: CONF,
    home: HOME,
  })
  assert.equal(rel.image, path.resolve(CONF, "wall.png"))
})

test("resolveSettings falls back to bundled image and ignores non-string image", () => {
  const s = resolveSettings({
    options: { image: 42, desktop: { image: "" } },
    configDir: CONF,
    home: HOME,
    bundledImage: "/bundled.png",
  })
  assert.equal(s.image, "/bundled.png")
})

test("readSettings reads JSONC cli.json from the config dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bee-gee-test-"))
  fs.writeFileSync(
    path.join(dir, "cli.json"),
    `{
      // comment
      "plugins": [{ "package": "./plugins/bee-gee", "options": { "desktop": { "brightness": 40 } } }],
    }`,
  )
  const s = readSettings({ configDir: dir, home: HOME, bundledImage: "/bundled.png" })
  assert.equal(s.dark.brightness, 0.4)
  assert.equal(s.image, "/bundled.png")
})

test("readSettings treats a missing cli.json as defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bee-gee-test-"))
  const s = readSettings({ configDir: dir, home: HOME, bundledImage: "/bundled.png" })
  assert.equal(s.enabled, true)
  assert.equal(s.image, "/bundled.png")
})

test("readSettings parse errors include the file path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bee-gee-test-"))
  const file = path.join(dir, "cli.json")
  fs.writeFileSync(file, "{ broken ]")
  assert.throws(
    () => readSettings({ configDir: dir, home: HOME }),
    new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  )
})

test("imageMime maps extensions and rejects others", () => {
  assert.equal(imageMime("/x/wall.png"), "image/png")
  assert.equal(imageMime("/x/wall.JPG"), "image/jpeg")
  assert.equal(imageMime("/x/wall.jpeg"), "image/jpeg")
  assert.equal(imageMime("/x/wall.webp"), "image/webp")
  assert.equal(imageMime("/x/wall.gif"), "image/gif")
  assert.equal(imageMime("/x/wall.avif"), "image/avif")
  assert.equal(imageMime("/x/wall.bmp"), "image/bmp")
  assert.equal(imageMime("/x/wall.svg"), "image/svg+xml")
  assert.equal(imageMime("/x/wall.tiff"), undefined)
  assert.equal(imageMime("/x/wall"), undefined)
})
