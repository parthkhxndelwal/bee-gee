/// <reference path="./pngjs.d.ts" />
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createResource, createSignal, onCleanup } from "solid-js"
import { PNG } from "pngjs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import os from "node:os"
import path from "node:path"

// Bundled wallpaper shipped with the package. Resolved relative to this file
// so the plugin works on any machine with no absolute paths in config.
// An explicit `image` option always wins over the bundled file.
function bundledImagePath(): string | undefined {
  try {
    const candidate = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "opencode-deepseek-theme.png")
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

type Pattern = "waves" | "grid" | "stars" | "diagonal"

const PATTERNS: Pattern[] = ["waves", "grid", "stars", "diagonal"]

function isPattern(value: unknown): value is Pattern {
  return typeof value === "string" && (PATTERNS as string[]).includes(value)
}

// Procedural pixel rows. Each string is one terminal row; characters are
// deliberately sparse + dim so the centered opencode logo stays readable.
// Spaces are transparent, so this layer never needs an opaque background.
function buildRows(pattern: Pattern, width: number, height: number): string[] {
  const rows: string[] = []
  for (let y = 0; y < height; y++) {
    let line = ""
    for (let x = 0; x < width; x++) {
      if (pattern === "waves") {
        const wave = Math.sin((x + y * 2.2) / 6) + Math.sin(y / 3 - x / 14)
        line += wave > 1.25 ? "~" : wave > 0.7 ? "-" : wave < -1.25 ? "." : " "
      } else if (pattern === "grid") {
        line += x % 8 === 0 || y % 4 === 0 ? (x % 8 === 0 && y % 4 === 0 ? "+" : x % 8 === 0 ? "|" : "-") : " "
      } else if (pattern === "diagonal") {
        line += (x + y * 2) % 12 === 0 ? "/" : (x + y * 2) % 12 === 6 ? "\\" : " "
      } else {
        // stars: deterministic pseudo-random from coords, no animation yet
        const hash = (x * 73856093) ^ (y * 19349663)
        const rand = ((hash >>> 0) % 100) / 100
        line += rand > 0.93 ? "*" : rand > 0.9 ? "." : " "
      }
    }
    rows.push(line)
  }
  return rows
}

// Unit setting accepting 0-1 or 0-100; always clamps to a sane range.
function clampUnit(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? parseFloat(value) : typeof value === "number" ? value : NaN
  if (!Number.isFinite(n)) return fallback
  const fraction = n > 1 ? n / 100 : n
  return Math.min(1, Math.max(0.05, fraction))
}

type RGB = readonly [number, number, number]

function hashName(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// Pre-process the image off-thread of rendering: decode PNG, apply brightness,
// then blend toward the UI background for opacity. Opacity is a pre-mult
// against the surrounding background (terminals have no alpha): opacity 1 is
// the image as-is, 0 is solid UI background. Cached per value-combination in
// the OS temp dir. Returns undefined on any failure (non-PNG, missing file,
// no fs) so the caller falls back to the original source.
async function processedImagePath(
  source: string,
  opts: { readonly brightness: number; readonly opacity: number; readonly bg: RGB },
): Promise<string | undefined> {
  if (opts.brightness >= 0.999 && opts.opacity >= 0.999) return source
  try {
    const png = PNG.sync.read(await readFile(source))
    const data = png.data
    const mix = 1 - opts.opacity
    const [br, bg2, bb] = opts.bg
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.min(255, Math.round(data[i] * opts.brightness * opts.opacity + br * mix))
      data[i + 1] = Math.min(255, Math.round(data[i + 1] * opts.brightness * opts.opacity + bg2 * mix))
      data[i + 2] = Math.min(255, Math.round(data[i + 2] * opts.brightness * opts.opacity + bb * mix))
    }
    const dir = path.join(os.tmpdir(), "bee-gee")
    await mkdir(dir, { recursive: true })
    const out = path.join(
      dir,
      `bg-${hashName(source)}-b${Math.round(opts.brightness * 100)}-o${Math.round(opts.opacity * 100)}-${hashName(opts.bg.join(","))}.png`,
    )
    await writeFile(out, PNG.sync.write(png))
    return out
  } catch {
    return undefined
  }
}

function BackgroundLayer(props: { enabled: boolean; pattern: Pattern; image?: string }) {
  const plugin = usePlugin()

  // Live terminal size. The old fixed 72x18 grid is why art only covered the
  // top-left quadrant on bigger terminals. Caps keep row generation cheap.
  const readSize = () => {
    let w = 80
    let h = 24
    try {
      w = (plugin.renderer as any)?.width ?? w
      h = (plugin.renderer as any)?.height ?? h
    } catch {
      // fall back to defaults
    }
    if (!Number.isFinite(w) || w < 1) w = 80
    if (!Number.isFinite(h) || h < 1) h = 24
    return { w: Math.min(Math.floor(w), 240), h: Math.min(Math.floor(h), 80) }
  }
  const [size, setSize] = createSignal(readSize())
  try {
    const onResize = () => setSize(readSize())
    ;(plugin.renderer as any)?.on?.("resize", onResize)
    onCleanup(() => (plugin.renderer as any)?.off?.("resize", onResize))
  } catch {
    // static size is fine
  }

  const route = () => {
    try {
      return plugin.ui.router.current()
    } catch {
      return { type: "home" } as const
    }
  }

  // Dim accent derived from theme so it works in dark + light mode.
  const artColor = () => {
    try {
      return (plugin.theme as any)?.text?.muted ?? (plugin.theme as any)?.text?.subtle ?? "#5b5b7a"
    } catch {
      return "#5b5b7a"
    }
  }

  return (
    <Show when={props.enabled && route().type === "home"}>
      {/* Full-screen transparent layer composed BEHIND the opencode UI
          (siblings paint in ascending zIndex, so negative puts us first).
          Wherever opencode draws text, it paints over us; our art only shows
          through empty cells. No backgroundColor on purpose: spaces stay
          transparent. */}
      <box position="absolute" left={0} top={0} width="100%" height="100%" flexDirection="column" zIndex={-1}>
        <Show when={typeof props.image === "string" && (props.image as string).length > 0}>
          {/* True image -> pixelated cells. protocol="blocks" forces the
              per-cell fallback (no kitty/sixel needed). If the file is
              missing opencode keeps the procedural rows below. */}
          {/* @ts-ignore - image intrinsics come from @opentui/solid at runtime */}
          <image source={props.image!} fit="cover" protocol="blocks" style={{ width: size().w, height: size().h }} />
        </Show>
        <For each={buildRows(props.pattern, size().w, size().h)}>{(line) => <text fg={artColor()}>{line}</text>}</For>
      </box>
    </Show>
  )
}

// Interactive percent slider rendered inside a dialog. Arrows apply live so
// the wallpaper updates while stepping. Scoped to the "modal" input mode,
// which the host pushes while any dialog is open, so arrows never leak into
// the prompt behind. Enter/escape both close (every step already applied).
function PercentSlider(props: { title: string; initial: number; onApply: (value: number) => void }) {
  const plugin = usePlugin()
  const [pct, setPct] = createSignal(Math.round(props.initial * 100))
  const step = (delta: number) => {
    const next = Math.min(100, Math.max(5, pct() + delta))
    if (next === pct()) return
    setPct(next)
    props.onApply(next / 100)
  }
  plugin.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { bind: "left", run: () => step(-5) },
      { bind: "right", run: () => step(5) },
      { bind: "enter", run: () => plugin.ui.dialog.clear() },
    ],
  }))
  const BAR = 24
  const filled = () => Math.round((pct() / 100) * BAR)
  const muted = () => {
    try {
      return (plugin.theme as any)?.text?.muted ?? "#5b5b7a"
    } catch {
      return "#5b5b7a"
    }
  }
  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text>
        {props.title}: {pct()}%
      </text>
      <text>{"█".repeat(filled()) + "░".repeat(BAR - filled())}</text>
      <text fg={muted()}>{"\u2190/\u2192 adjust · live preview · enter/esc done"}</text>
    </box>
  )
}

export default Plugin.define({
  id: "bee-gee",
  setup(context) {
    const rawPattern = (context.options as any)?.pattern
    const rawImage = (context.options as any)?.image
    const initialPattern: Pattern = isPattern(rawPattern) ? rawPattern : "waves"
    const explicitImage = typeof rawImage === "string" && rawImage.length > 0 ? rawImage : undefined
    const image: string | undefined = explicitImage ?? bundledImagePath()
    const initialBrightness = clampUnit((context.options as any)?.brightness, 0.6)
    const initialOpacity = clampUnit((context.options as any)?.opacity, 1)
    // Blend target for opacity: the resolved UI background (stock theme =>
    // opaque dark, so fading looks exact against surrounding cells).
    let uiBg: RGB = [0, 0, 0]
    try {
      const ints = (context.theme as any)?.background?.default?.toInts?.() as
        [number, number, number, number] | undefined
      if (Array.isArray(ints) && ints.length >= 3) {
        uiBg = [
          Math.min(255, Math.max(0, Math.round(ints[0]))),
          Math.min(255, Math.max(0, Math.round(ints[1]))),
          Math.min(255, Math.max(0, Math.round(ints[2]))),
        ]
      }
    } catch {
      // fall back to black
    }

    const [settings, updateSettings] = context.storage.store("settings", {
      initial: {
        enabled: true,
        pattern: initialPattern as string,
        brightness: initialBrightness,
        opacity: initialOpacity,
      },
    })

    const normalizedPattern = (): Pattern => (isPattern(settings.pattern) ? settings.pattern : "waves")
    const enabled = () => settings.enabled !== false
    // Older stored settings predate brightness/opacity; fall back to options.
    const brightness = () => clampUnit((settings as any).brightness, initialBrightness)
    const opacity = () => clampUnit((settings as any).opacity, initialOpacity)

    const toggle = async () => {
      await updateSettings((draft) => {
        draft.enabled = !draft.enabled
      })
      context.ui.toast.show({
        message: `background ${enabled() ? "on" : "off"} (palette: Background art)`,
        variant: "info",
      })
    }

    const nextPattern = async () => {
      const current = normalizedPattern()
      const next = PATTERNS[(PATTERNS.indexOf(current) + 1) % PATTERNS.length]
      await updateSettings((draft) => {
        draft.pattern = next
        draft.enabled = true
      })
      context.ui.toast.show({ message: `background pattern: ${next}`, variant: "success" })
    }

    const resetToConfig = async () => {
      await updateSettings((draft) => {
        draft.enabled = true
        draft.pattern = initialPattern
        ;(draft as any).brightness = initialBrightness
        ;(draft as any).opacity = initialOpacity
      })
      context.ui.toast.show({ message: "background reset to cli.json settings", variant: "success" })
    }

    // GUI settings menu (same select/prompt primitives the built-in settings
    // dialog uses). 2.0.3 offers plugins no way to inject rows into the real
    // settings menu, so this palette-opened dialog is the native equivalent.
    const openSettingsMenu = async (): Promise<void> => {
      for (;;) {
        const choice = await context.ui.dialog.select({
          title: "Background art",
          placeholder: "choose a setting",
          current: "pattern",
          options: [
            {
              title: `Enabled: ${enabled() ? "on" : "off"}`,
              value: "enabled",
              description: "toggle the background layer",
            },
            {
              title: `Pattern: ${normalizedPattern()}`,
              value: "pattern",
              description: "procedural art behind the wallpaper",
            },
            {
              title: `Brightness: ${Math.round(brightness() * 100)}%`,
              value: "brightness",
              description: "dim the wallpaper",
            },
            {
              title: `Opacity: ${Math.round(opacity() * 100)}%`,
              value: "opacity",
              description: "fade toward the UI background",
            },
            { title: "Reset to cli.json", value: "reset", description: "clear all overrides" },
          ],
        })
        if (choice === undefined) return
        if (choice === "enabled") {
          await updateSettings((draft) => {
            draft.enabled = !draft.enabled
          })
          continue
        }
        if (choice === "reset") {
          await resetToConfig()
          return
        }
        if (choice === "pattern") {
          const next = await context.ui.dialog.select({
            title: "Background pattern",
            current: normalizedPattern(),
            options: PATTERNS.map((p) => ({ title: p, value: p })),
          })
          if (next === undefined) continue
          await updateSettings((draft) => {
            draft.pattern = next
            draft.enabled = true
          })
          continue
        }
        const isBrightness = choice === "brightness"
        await new Promise<void>((done) => {
          context.ui.dialog.show(
            () => (
              <PercentSlider
                title={isBrightness ? "Wallpaper brightness" : "Wallpaper opacity"}
                initial={isBrightness ? brightness() : opacity()}
                onApply={(v) => {
                  void updateSettings((draft) => {
                    if (isBrightness) (draft as any).brightness = v
                    else (draft as any).opacity = v
                    draft.enabled = true
                  })
                }}
              />
            ),
            () => done(),
          )
        })
        continue
      }
    }

    // NOTE: keymap.layer must be called inside a component (it is owned by
    // the calling component). Calling it directly in setup fails with
    // "Keymap.Provider is missing", so the Host below owns the layer.
    function Host() {
      // Re-process only when the source, brightness, or opacity changes;
      // while the temp file is being written the original source shows.
      const [processed] = createResource(
        () => (image ? `${brightness()}:${opacity()}` : null),
        async () =>
          image
            ? await processedImagePath(image, { brightness: brightness(), opacity: opacity(), bg: uiBg })
            : undefined,
      )
      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "bg.settings",
            title: "Background art: settings",
            description: "wallpaper pattern brightness opacity settings",
            group: "Background",
            palette: true,
            suggested: true,
            run: () => void openSettingsMenu(),
          },
          {
            id: "bg.toggle",
            title: "Background art: toggle",
            group: "Background",
            palette: true,
            run: () => void toggle(),
          },
          {
            id: "bg.next",
            title: "Background art: next pattern",
            group: "Background",
            palette: true,
            run: () => void nextPattern(),
          },
        ],
        bindings: ["bg.settings", "bg.toggle", "bg.next"],
      }))

      return <BackgroundLayer enabled={enabled()} pattern={normalizedPattern()} image={processed() ?? image} />
    }

    const cleanups = [
      context.ui.slot({
        append: "app",
        render: () => <Host />,
      }),
      context.ui.slot({
        append: "home.footer",
        render: () => (
          <Show when={enabled()}>
            <text fg={(context.theme as any)?.text?.muted ?? "#5b5b7a"}>
              {`bg:${normalizedPattern()} dim${Math.round(brightness() * 100)} op${Math.round(opacity() * 100)}`}
            </text>
          </Show>
        ),
      }),
    ]

    context.ui.toast.show({ message: "bee-gee loaded (palette: Background art)", variant: "success", duration: 2500 })

    return () => {
      for (const dispose of cleanups) dispose()
    }
  },
})
