# Contributing to bee-gee

Thanks for stopping by — contributions are welcome, whether that's a bug fix,
a new procedural pattern, docs, or ideas.

## Getting started

Requirements: Node 18+, [opencode](https://opencode.ai) 2.x, git.

```sh
git clone https://github.com/parthkhxndelwal/bee-gee.git
cd bee-gee
npm install
```

## Local development

The fastest loop is loading the checkout directly as a local plugin:

```jsonc
// cli.json
{
  "plugins": [{ "package": "/absolute/path/to/bee-gee" }],
}
```

Then open `opencode` — the TUI hot-reloads `tui.tsx` on save, so most UI
iterations need no restart. (`index.ts` is a server-side stub; changes there
need the background service to pick them up.)

Useful commands:

```sh
npm run format            # prettier --write .
npm run format:check      # fail on unformatted files (CI runs this)
npm run typecheck         # tsc --noEmit over tui.tsx
npm test                  # node --test desktop/
npm run typecheck:desktop # tsc --checkJs over the desktop launcher/injector
```

## Style

- `npm run format` before committing — CI enforces prettier.
- Keep the runtime dependency footprint tiny: the plugin loads inside the
  user's TUI, so prefer pure-JS, zero-native-dependency packages.
- Don't add absolute paths, machine-specific values, or secrets. Everything
  configurable belongs in plugin `options` with a documented default.

## Where things live

- `tui.tsx` — everything: background layer, procedural patterns, image
  pre-processing (brightness/opacity via `pngjs`), settings dialog, palette
  commands.
- `index.ts` — server entry: hosts the Desktop auto-injector
  (`desktop/auto.mjs`). Keep it to relative imports + node builtins so it
  loads under the server's module resolver without `node_modules`.
- `assets/` — bundled wallpaper(s). Strip metadata before adding images
  (decode + re-encode drops ancillary PNG chunks).
- `pngjs.d.ts` — minimal typings for the untyped `pngjs` dependency.
- `desktop/launch.mjs` — `bee-gee-desktop` CLI: thin arg-parsing wrapper over
  attach.mjs (finds the app, picks attach vs launch, prints results).
- `desktop/attach.mjs` — shared injection machinery: process detection,
  graceful quit, inspector polling, the CDP client, and the
  attach/launch + inject + close-inspector flows.
- `desktop/auto.mjs` — in-service auto-injection: watches Desktop's
  `SingletonLock` in its userData dir, validates the pid, injects. Called by
  `index.ts` via a refcounted `acquire()`.
- `desktop/injector.cjs` — the code evaluated inside the Electron main
  process: tracks renderers, watches cli.json + the image, applies the
  wallpaper stylesheet. `renderWallpaper()` is serialized into the renderer,
  so it must stay self-contained.
- `desktop/config.cjs` — shared cli.json/JSONC/settings helpers (node
  builtins only). `desktop/config.test.mjs` covers it.

## Pull requests

1. Fork, branch off `main` (`feat/...`, `fix/...`).
2. Keep PRs focused; one change per PR.
3. Update `README.md` when behavior or options change.
4. Ensure `npm run format:check` and `npm run typecheck` pass.

## Reporting issues

Include: opencode version (`opencode --version`), OS + terminal, plugin
options from `cli.json`, and any `opencode-bg|bee-gee` lines from the log at
`~/.local/share/opencode/log/opencode.log` (macOS/Linux) or
`%USERPROFILE%\.local\share\opencode\log\opencode.log` (Windows). A screenshot
helps a lot for rendering issues.
