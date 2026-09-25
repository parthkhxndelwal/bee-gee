// @ts-check
import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { wallpaperCss } = require("./injector.cjs")
const { resolveSettings } = require("./config.cjs")

const settings = (options) => resolveSettings({ options, configDir: "/cfg", home: "/home" })
const payload = (options) => ({ ...settings(options), image: { key: "k1", mime: "image/png", base64: "AAAA" } })

const ruleBody = (css, selector) => {
  const start = css.indexOf(selector)
  assert.notEqual(start, -1, `missing rule ${selector}`)
  return css.slice(start, css.indexOf("\n}", start))
}

test("both schemes retain the original image colors, including stale invert options", () => {
  const css = wallpaperCss(payload({ desktop: { invert: true, light: { invert: "auto" } } }), "blob:original")
  assert.doesNotMatch(css, /(?:invert\(|hue-rotate\(|filter:)/)
  const image = ruleBody(css, "html[data-bee-gee]::before")
  assert.ok(image.includes('url("blob:original")'))
  assert.ok(image.includes("z-index: -1"))
  assert.ok(image.includes("pointer-events: none"))
  assert.ok(image.includes("image-rendering: pixelated"))
  assert.equal(css.split("image-rendering").length - 1, 1)
  assert.doesNotMatch(wallpaperCss(payload({ desktop: { pixelated: false } }), "blob:x"), /image-rendering/)
})

test("light mode backs reading surfaces while the dark wallpaper treatment stays unchanged", () => {
  const css = wallpaperCss(payload(), "blob:x")
  const dark = ruleBody(css, "html[data-bee-gee]")
  assert.ok(dark.includes("--bee-gee-panel: 25%"))
  assert.ok(dark.includes("--bee-gee-scrim: rgb(0 0 0 / 0.4)"))
  for (const selector of [
    'html[data-bee-gee][data-color-scheme="light"]',
    "html[data-bee-gee]:not([data-color-scheme])",
  ]) {
    const light = ruleBody(css, selector)
    assert.ok(light.includes("--bee-gee-panel: 95%"))
    assert.ok(light.includes("--bee-gee-scrim: rgb(0 0 0 / 0.3)"))
    assert.ok(light.includes("var(--bee-gee-deep) 0%, transparent"), "default image has no theme-colored wash")
    assert.ok(ruleBody(css, `${selector} [data-component="new-session"]`).includes("background-color: transparent"))
    assert.ok(ruleBody(css, `${selector} header`).includes("background-color: var(--bee-gee-deep)"))
    assert.ok(ruleBody(css, `${selector} body`).includes("--v2-text-text-faint: var(--v2-text-text-muted)"))
  }
  assert.ok(css.includes("@media (prefers-color-scheme: light)"))
})

test("light conversation backing is limited to content, never the full-height canvas or dock", () => {
  const css = wallpaperCss(payload(), "blob:x")
  for (const selector of [
    'html[data-bee-gee][data-color-scheme="light"]',
    "html[data-bee-gee]:not([data-color-scheme])",
  ]) {
    for (const surface of [
      '[data-slot="session-chat-panel"] > :is(.bg-v2-background-bg-base, .bg-background-stronger)',
      '[data-component="session-composer-dock"]',
      '[data-component="session-prompt-dock"]',
    ]) {
      assert.ok(ruleBody(css, `${selector} ${surface}`).includes("background-color: transparent"))
    }
    const message = ruleBody(css, `${selector} :is([data-slot="session-turn-assistant-content"]`)
    assert.ok(message.includes('data-slot="session-turn-thinking"'))
    assert.ok(message.includes('data-slot="session-turn-retry"'))
    assert.ok(message.includes(":not(:empty)"))
    assert.ok(message.includes("background-color: var(--v2-background-bg-base)"))
    assert.ok(message.includes("width: fit-content"))
    assert.ok(message.includes("max-width: 100%"))
  }
  assert.doesNotMatch(css, /\[data-timeline-virtual-content\]|\[data-component="session-turn"\]/)
})

test("serialized CSS generator preserves independent user tuning for both schemes", () => {
  const p = payload({
    desktop: { dark: { brightness: 80, opacity: 75 }, light: { brightness: 90, opacity: 60, panelOpacity: 100 } },
  })
  const serialized = new Function(`return ${wallpaperCss.toString()}`)()
  const css = serialized(p, "blob:custom")
  assert.equal(css, wallpaperCss(p, "blob:custom"))
  const dark = ruleBody(css, "html[data-bee-gee]")
  assert.ok(dark.includes("--bee-gee-scrim: rgb(0 0 0 / 0.2)"))
  assert.ok(dark.includes("var(--bee-gee-deep) 25%, transparent"))
  const light = ruleBody(css, 'html[data-bee-gee][data-color-scheme="light"]')
  assert.ok(light.includes("--bee-gee-scrim: rgb(0 0 0 / 0.1)"))
  assert.ok(light.includes("var(--bee-gee-deep) 40%, transparent"))
  assert.ok(light.includes("--bee-gee-panel: 100%"))
})
