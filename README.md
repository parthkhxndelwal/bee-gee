![bee-gee](assets/device-shot.png)

It renders a full-screen image behind the UI (cell-by-cell block art, so it
works in any truecolor terminal — no Kitty/Sixel needed), with procedural art
patterns as fallback, live brightness/opacity sliders, and a bundled
metadata-free wallpaper.

## Requirements

- [opencode](https://opencode.ai) 2.x (`opencode --version`)
- A truecolor terminal (Ghostty, WezTerm, Alacritty, Kitty, Windows Terminal…)
- Node 18+ (for install only)

## Install

Directly from GitHub — no clone needed:

```sh
opencode plugin add parthkhxndelwal/bee-gee
```

Or clone it as a local plugin:

```sh
git clone https://github.com/parthkhxndelwal/bee-gee.git ~/.config/opencode/plugins/bee-gee
```

```jsonc
// ~/.config/opencode/cli.json
{
  "plugins": [{ "package": "./plugins/bee-gee" }],
}
```

Then open `opencode` — you should see the wallpaper behind the home screen
and a `bee-gee loaded` toast.

## Usage

Open the command palette (`Ctrl+P`):

- **Background art: settings** — also matches `settings` / `bg` in the
  filter. Native settings-style dialog: enabled, pattern, wallpaper
  brightness and opacity, reset to `cli.json`. Brightness/opacity open an
  interactive bar: **←/→ adjust in 5% steps with live preview**, enter/esc to
  finish.
- **Background art: toggle** / **Background art: next pattern** — quick
  actions in the same group.

The home footer shows the live state (`bg:grid dim60 op100`).

## Options (`cli.json`)

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/bee-gee",
      "options": {
        "pattern": "waves", // waves | grid | stars | diagonal
        "image": "/absolute/path/to/wallpaper.png", // optional override
        "brightness": 0.6, // 0.05-1 (or 5-100), default 0.6
        "opacity": 1, // 0.05-1 (or 5-100), default 1
      },
    },
  ],
}
```

| Option       | Default           | Notes                                                                                          |
| ------------ | ----------------- | ---------------------------------------------------------------------------------------------- |
| `pattern`    | `waves`           | Procedural art behind/under the wallpaper.                                                     |
| `image`      | bundled wallpaper | Omit to use `assets/opencode-deepseek-theme.png`. Absolute path wins. PNG only for processing. |
| `brightness` | `0.6`             | Pre-dims the image.                                                                            |
| `opacity`    | `1`               | Pre-blends toward the resolved UI background (terminals have no alpha).                        |

Palette/dialog adjustments persist on top of these; **Background art →
Reset to cli.json** (in the settings dialog) hands authority back to the file.

## How it works

- Appends a transparent full-screen layer to the `app` slot, home route only,
  composed **behind** the UI (`zIndex: -1`) — opencode always paints over it,
  so text is never covered.
- `<image protocol="blocks">` rasterizes the wallpaper into terminal cells.
- Brightness/opacity are pre-computed with pure-JS `pngjs` (no native deps)
  and cached per value in the OS temp dir.
- Zero-import server stub (`index.ts`) so the package loads under the
  server's resolver without `node_modules`.

Known platform limits (verified against the opencode 2.0.3 sources): the logo
glyphs carry an opaque shadow color and the prompt textarea has a built-in
fill — neither is reachable from any plugin API, so those two elements keep
their designed backdrops while the wallpaper fills everything else.

## OpenCode Desktop

The desktop app has no plugin system, so bee-gee injects the wallpaper into
the running app instead. The image is rendered **behind** the whole UI: the
window background shows the wallpaper and the app's raised panels become
translucent so it shows through.

### Automatic (recommended)

When bee-gee is installed as an opencode plugin — the background service
loads it, e.g. cloned into `~/.config/opencode/plugins/bee-gee` or listed in
`opencode.json` `plugins` — it injects automatically every time OpenCode
Desktop starts. No extra process and nothing to launch: the watcher lives
inside the opencode background service. It watches Desktop's `SingletonLock`,
validates that the pid it names really is the OpenCode main process, briefly
opens the app's inspector via SIGUSR1 on `127.0.0.1:9229`, injects, and
closes it again. Opt out with `"desktop": { "autoInject": false }`.
macOS/Linux only.

### Manual

The `bee-gee-desktop` launcher remains for Windows, or when bee-gee is not
installed as a plugin (it also works as a one-shot injector). Requires
Node 22+ (the launcher needs the global `WebSocket`):

```sh
# no install — run it straight from GitHub
npx --package=github:takltc/bee-gee bee-gee-desktop

# or from a local checkout / installed plugin
node <plugin dir>/desktop/launch.mjs
```

- OpenCode **not running** → the launcher starts it with a temporary
  inspector, injects, and disconnects.
- OpenCode **already running** (macOS/Linux) → it attaches in place: SIGUSR1
  opens the app's inspector, the injector is evaluated, the inspector is
  closed again. Pass `--restart` to quit and relaunch instead.
- `--app <path>` (or `BEE_GEE_OPENCODE_APP`) points at a non-standard install;
  on macOS a `.app` bundle path works too. Extra args after `--` are passed
  to the app on launch.

Settings live in the same `cli.json` plugin options, under a `desktop` block,
and **apply live** — saving the file (or the image it points at) updates the
wallpaper without a restart. `brightness`, `opacity`, and `panelOpacity`
can be set once at the `desktop` level (shared by both schemes) or
per color scheme inside `desktop.dark` / `desktop.light`:

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/bee-gee",
      "options": {
        "desktop": {
          "enabled": true,
          "image": "~/Pictures/wall.png", // optional; falls back to `image`, then the bundled wallpaper
          "pixelated": true, // nearest-neighbor scaling keeps pixel art crisp; false for photos
          "autoInject": true, // inject automatically on every Desktop start (default true)
          "dark": { "brightness": 0.6, "opacity": 1, "panelOpacity": 0.25 },
          "light": { "brightness": 0.7, "opacity": 1, "panelOpacity": 0.95 },
        },
      },
    },
  ],
}
```

Precedence per scheme: `desktop.<scheme>.x` → `desktop.x` → (dark only)
plugin-level `x` → default. TUI `brightness`/`opacity` options feed the dark
scheme only — they are tuned for a dark terminal.

Numeric settings accept fractions (`0.05`–`1`) or percentages (`5`–`100`)
and clamp to that range.

Both schemes preserve the wallpaper's original colors. In light mode, the
home screen's central content card and top toolbar get their own backdrops,
while the conversation canvas and composer docks remain transparent. The
95% backing is localized to assistant content, working/retry status, message
metadata and the input box, leaving the wallpaper visible around them.
Muted labels use the theme's secondary text color for readability.

| Option                         | Default (dark / light) | Notes                                                                                                                 |
| ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `enabled`                      | `true`                 | Set `false` to keep the injector but hide the wallpaper.                                                              |
| `image`                        | bundled wallpaper      | `~` expands, relative paths resolve against the config dir.                                                           |
| `pixelated`                    | `true`                 | Nearest-neighbor scaling (crisp pixel art, like the TUI's block rendering). Set `false` for smooth scaling of photos. |
| `autoInject`                   | `true`                 | Automatically inject on every Desktop start via the plugin-loaded service hook. Set `false` to only inject manually.  |
| `dark`/`light` `.brightness`   | `0.6` / `0.7`          | Dims the image toward black in both schemes.                                                                          |
| `dark`/`light` `.opacity`      | `1` / `1`              | Lower values fade the image toward the theme's window background; the default adds no wash.                           |
| `dark`/`light` `.panelOpacity` | `0.25` / `0.95`        | How opaque content backdrops (home card, messages, input, dialogs) stay over the wallpaper.                           |

### How the desktop injection works

The injector opens the Electron main-process inspector on `127.0.0.1` only —
via SIGUSR1 on an already-running instance, or by launching the app with
`--inspect` — evaluates `desktop/injector.cjs` inside it, and closes the
inspector right after. Nothing in the app bundle is modified. The injector
watches `cli.json` and the image file for live reload; diagnostic lines go to
`<tmpdir>/bee-gee/desktop.log` (auto-inject lines are prefixed `[auto]`).

### Desktop limitations

- Auto-injection needs the plugin loaded by the opencode background service
  (`opencode serve --service`, which Desktop starts) — macOS/Linux only. If
  the service isn't running the wallpaper won't appear; the manual launcher
  still works.
- Manual injection is in-memory: **re-run `bee-gee-desktop` after each app
  restart** if the plugin path isn't set up.
- Only `cli.json` is shared with the TUI plugin — palette/storage overrides
  made inside the TUI do not carry over (and vice versa).
- Windows/Linux install paths are untested; on Windows, attaching to an
  already-running instance is not possible (quit the app or use `--restart`).

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
