#!/usr/bin/env node
// @ts-check
// bee-gee-desktop: inject the bee-gee wallpaper into OpenCode Desktop.
//
// OpenCode Desktop has no plugin system, so this launcher opens the app's
// devtools inspector (only on 127.0.0.1, only for the duration of the
// injection), evaluates desktop/injector.cjs inside the Electron main
// process, then closes the inspector again. Nothing in the app bundle is
// modified, so the wallpaper is gone after the app restarts — re-run this
// (or let the plugin's auto-injection do it; see README).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { ATTACH_PORT, INSPECT_HOST, attachAndInject, findRunningPid, gracefulQuit, launchAndInject } from "./attach.mjs"

class CliError extends Error {}

const warn = (/** @type {string} */ message) => console.error(`bee-gee-desktop: warning: ${message}`)

const HELP = `bee-gee-desktop — put the bee-gee wallpaper behind OpenCode Desktop

Usage:
  bee-gee-desktop [--app <path>] [--restart] [-- <extra app args>]

Options:
  --app <path>   OpenCode executable (or a .app bundle on macOS).
                 Env: BEE_GEE_OPENCODE_APP
  --restart      gracefully quit a running instance first, then relaunch
  --help         show this help

While OpenCode is already running this attaches over the devtools inspector
(SIGUSR1 on ${INSPECT_HOST}:${ATTACH_PORT}, POSIX only). Otherwise it launches
the app with a temporary inspector, injects, and closes it again.`

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ app?: string, restart: boolean, help: boolean, extra: string[] }} */
  const opts = { restart: false, help: false, extra: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--") {
      opts.extra = argv.slice(i + 1)
      break
    }
    if (arg === "--app") {
      const value = argv[++i]
      if (!value) throw new CliError("--app requires a path")
      opts.app = value
      continue
    }
    if (arg.startsWith("--app=")) {
      opts.app = arg.slice("--app=".length)
      if (!opts.app) throw new CliError("--app requires a path")
      continue
    }
    if (arg === "--restart") {
      opts.restart = true
      continue
    }
    if (arg === "--help" || arg === "-h") {
      opts.help = true
      continue
    }
    throw new CliError(`unknown argument: ${arg} (try --help)`)
  }
  return opts
}

/**
 * Candidate executables per platform; first existing wins.
 * @returns {string[]}
 */
function defaultExecutables() {
  if (process.platform === "darwin") {
    return [
      "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
      path.join(os.homedir(), "Applications/OpenCode.app/Contents/MacOS/OpenCode"),
    ]
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA
    return local ? [path.join(local, "Programs", "OpenCode", "OpenCode.exe")] : []
  }
  return ["/opt/OpenCode/ai.opencode.desktop", "/usr/bin/ai.opencode.desktop"]
}

/**
 * Resolve the OpenCode executable from --app / env / platform defaults.
 * @param {string | undefined} requested
 * @returns {string}
 */
function resolveExecutable(requested) {
  if (requested) {
    let exe = requested.startsWith("~/") ? path.join(os.homedir(), requested.slice(2)) : requested
    if (process.platform === "darwin" && exe.endsWith(".app")) {
      exe = path.join(exe, "Contents", "MacOS", "OpenCode")
    }
    if (!fs.existsSync(exe)) {
      throw new CliError(
        `OpenCode executable not found: ${exe}\nPass --app <path> (or BEE_GEE_OPENCODE_APP) to point at it.`,
      )
    }
    return exe
  }
  for (const candidate of defaultExecutables()) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new CliError("could not find an OpenCode Desktop install — pass --app <path> or set BEE_GEE_OPENCODE_APP")
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return
  }
  if (typeof (/** @type {any} */ (globalThis).WebSocket) !== "function") {
    throw new CliError("bee-gee-desktop requires Node 22 or newer (global WebSocket not found)")
  }

  const exe = resolveExecutable(opts.app ?? process.env.BEE_GEE_OPENCODE_APP)
  const pid = findRunningPid(exe)

  /** @type {number} */
  let appPid

  if (pid !== null && !opts.restart) {
    if (process.platform === "win32") {
      throw new CliError(
        "OpenCode is already running and Windows cannot attach to a running instance — quit OpenCode or re-run with --restart",
      )
    }
    await attachAndInject({ pid, warn })
    appPid = pid
  } else {
    if (pid !== null) await gracefulQuit(pid)
    const child = await launchAndInject({ exe, extra: opts.extra, warn })
    appPid = child.pid ?? pid ?? 0
  }

  console.log(`bee-gee-desktop: wallpaper active in OpenCode (pid ${appPid}) — edits to cli.json apply live`)
}

main().catch((err) => {
  if (process.env.BEE_GEE_DEBUG === "1") {
    console.error(err)
  } else {
    console.error(`bee-gee-desktop: ${err instanceof Error ? err.message : String(err)}`)
  }
  process.exitCode = 1
})
