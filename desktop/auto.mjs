// @ts-check
// Auto-injection for OpenCode Desktop, hosted inside the opencode background
// service: index.ts calls acquire() per plugin location, and the refcounted
// singleton below shares one watcher across all of them.
//
// Event-driven: Chromium drops a SingletonLock symlink in the app's userData
// dir when the main process takes the single-instance lock. We watch for it,
// validate that the pid it names really is the OpenCode main process — a
// stale lock can survive a crash and point at a dead or REUSED pid, and
// SIGUSR1 to the wrong process can kill it — then run the same
// inspector-attach injection as `bee-gee-desktop`.
//
// Every callback and promise here is caught and logged: an exception
// escaping would crash the user's OpenCode service.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import config from "./config.cjs"
import { attachAndInject } from "./attach.mjs"

const STATE_KEY = Symbol.for("bee-gee.desktop.auto")
const BOOK_KEY = Symbol.for("bee-gee.desktop.auto.book")

const LOCK_NAME = "SingletonLock"
const SETTLE_MS = 1500
const DEBOUNCE_MS = 300
const EXIST_POLL_MS = 30000
const RETRY_DELAYS_MS = [5000, 15000, 45000]

/**
 * @typedef {object} AutoOptions
 * @property {(message: string) => void} [log]
 * @property {string} [userDataDir] Desktop userData dir (test override)
 * @property {string} [platform] process.platform override (tests)
 * @property {(pid: number) => Promise<any>} [inject] injection impl (tests)
 * @property {(pid: number) => string | null} [argsOf] process args lookup (tests)
 * @property {(args: string | null) => boolean} [isMain] OpenCode-main validator (tests)
 * @property {() => boolean} [enabled] autoInject gate (tests)
 * @property {number} [settleMs] settle delay before injecting (tests)
 * @property {number} [debounceMs] watcher debounce (tests)
 * @property {number} [existPollMs] userData existence poll (tests)
 * @property {number[]} [retryDelays] retry backoff (tests)
 *
 * @typedef {object} AutoState
 * @property {number} refs
 * @property {boolean} stopped
 * @property {Required<AutoOptions>} opts
 * @property {fs.FSWatcher | null} watcher
 * @property {NodeJS.Timeout | null} debounce
 * @property {NodeJS.Timeout | null} poll
 *
 * @typedef {{ injected: Set<number>, inflight: Set<number>, attempts: Map<number, number> }} AutoBook
 */

/** @param {unknown} err */
const errMsg = (err) => (err instanceof Error ? err.message : String(err))

/**
 * Chromium userData dir for OpenCode Desktop, or undefined where
 * auto-injection is unsupported (Windows has no SIGUSR1 attach path).
 * @param {string} platform
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 * @returns {string | undefined}
 */
export function desktopUserDataDir(platform, env, home) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "ai.opencode.desktop")
  if (platform === "linux") {
    const xdg = env.XDG_CONFIG_HOME
    const base = typeof xdg === "string" && xdg.length > 0 ? xdg : path.join(home, ".config")
    return path.join(base, "ai.opencode.desktop")
  }
  return undefined
}

/**
 * SingletonLock target "<hostname>-<pid>" → pid. The hostname itself may
 * contain dashes, so the pid is the digits after the LAST dash; anything
 * non-numeric or non-positive is not a pid.
 * @param {string | null | undefined} target
 * @returns {number | null}
 */
export function parseSingletonLock(target) {
  const match = /-(\d+)$/.exec(target ?? "")
  if (!match) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/**
 * True when a ps args string is the OpenCode Desktop MAIN process (helpers
 * carry " --type="). darwin matches the .app bundle executable suffix (the
 * bundle dir may itself contain spaces if the user renamed it); linux
 * matches the executable basename.
 * @param {string | null | undefined} args
 * @param {string} platform
 * @returns {boolean}
 */
export function isOpenCodeMainArgs(args, platform) {
  if (typeof args !== "string" || args.length === 0) return false
  if (args.includes(" --type=")) return false
  if (platform === "darwin") {
    const marker = ".app/Contents/MacOS/OpenCode"
    const i = args.indexOf(marker)
    return i > 0 && (args.length === i + marker.length || args[i + marker.length] === " ")
  }
  if (platform === "linux") {
    return path.basename(args.split(" ")[0]) === "ai.opencode.desktop"
  }
  return false
}

/**
 * Full args of a pid via ps, or null when the process is gone.
 * @param {number} pid
 * @returns {string | null}
 */
export function processArgs(pid) {
  try {
    const out = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" })
    if (out.status !== 0 || typeof out.stdout !== "string") return null
    const args = out.stdout.trim()
    return args.length > 0 ? args : null
  } catch {
    return null
  }
}

/**
 * Append one `[auto]` line to the shared desktop log; never throws.
 * @returns {(message: string) => void}
 */
function defaultLog() {
  const file = path.join(os.tmpdir(), "bee-gee", "desktop.log")
  return (message) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${new Date().toISOString()} [auto] ${message}\n`)
    } catch {
      // logging must never throw
    }
  }
}

/**
 * @returns {AutoBook} injected pids + attempt counters. Lives on its own
 * globalThis key so it survives acquire/release cycles AND hot reloads
 * (a reloaded module must not re-inject a Desktop that is already done).
 */
function book() {
  const g = /** @type {any} */ (globalThis)
  return (
    g[BOOK_KEY] ??
    (g[BOOK_KEY] = /** @type {AutoBook} */ ({ injected: new Set(), inflight: new Set(), attempts: new Map() }))
  )
}

/**
 * Run fn and route any throw/rejection to the log — the error boundary for
 * every watcher/timer/async continuation in this module.
 * @param {AutoState} state
 * @param {() => void | Promise<void>} fn
 */
function run(state, fn) {
  try {
    Promise.resolve(fn()).catch((err) => state.opts.log(`error: ${errMsg(err)}`))
  } catch (err) {
    state.opts.log(`error: ${errMsg(err)}`)
  }
}

/**
 * The enabled gate: desktop.autoInject !== false in cli.json. An unreadable
 * config defaults to enabled — the user installed the plugin, and the
 * injector itself still applies desktop.enabled.
 * @param {AutoState} state
 * @returns {boolean}
 */
function enabled(state) {
  try {
    return state.opts.enabled()
  } catch (err) {
    state.opts.log(`settings unreadable (${errMsg(err)}) — injecting anyway`)
    return true
  }
}

/** @param {AutoState} state */
function readLockPid(state) {
  try {
    return parseSingletonLock(fs.readlinkSync(path.join(state.opts.userDataDir, LOCK_NAME)))
  } catch {
    return null
  }
}

/**
 * Retry a failed injection for the same pid after retryDelays[n]; aborted
 * silently when the pid died, the lock moved, or we were stopped.
 * @param {AutoState} state
 * @param {number} pid
 */
function scheduleRetry(state, pid) {
  const b = book()
  const n = b.attempts.get(pid) ?? 0
  if (n >= state.opts.retryDelays.length) {
    state.opts.log(`giving up on pid ${pid} after ${n} failed attempts`)
    b.attempts.delete(pid)
    return
  }
  b.attempts.set(pid, n + 1)
  const timer = setTimeout(() => {
    run(state, async () => {
      if (state.stopped || b.inflight.has(pid)) return
      if (readLockPid(state) !== pid || !state.opts.isMain(state.opts.argsOf(pid))) {
        b.attempts.delete(pid)
        return
      }
      b.inflight.add(pid)
      await attemptInject(state, pid)
    })
  }, state.opts.retryDelays[n])
  timer.unref?.()
}

/**
 * Wait for the app to settle, re-validate the pid (still OpenCode main,
 * lock still pointing at it), then inject.
 * @param {AutoState} state
 * @param {number} pid
 */
async function attemptInject(state, pid) {
  const b = book()
  try {
    await new Promise((resolve) => setTimeout(resolve, state.opts.settleMs))
    if (state.stopped) return
    if (readLockPid(state) !== pid) return
    if (!state.opts.isMain(state.opts.argsOf(pid))) {
      state.opts.log(`pid ${pid} no longer looks like OpenCode main — aborting inject`)
      return
    }
    await state.opts.inject(pid)
    b.injected.add(pid)
    b.attempts.delete(pid)
    state.opts.log(`injected into OpenCode Desktop (pid ${pid})`)
  } catch (err) {
    state.opts.log(`inject failed for pid ${pid}: ${errMsg(err)}`)
    scheduleRetry(state, pid)
  } finally {
    b.inflight.delete(pid)
  }
}

/**
 * One pass: prune dead pids, read the lock, validate, inject.
 * @param {AutoState} state
 */
async function check(state) {
  if (state.stopped) return
  if (!enabled(state)) return
  const b = book()
  for (const pid of [...b.injected]) {
    if (state.opts.argsOf(pid) === null) b.injected.delete(pid)
  }
  const pid = readLockPid(state)
  if (pid === null || b.injected.has(pid) || b.inflight.has(pid)) return
  const args = state.opts.argsOf(pid)
  if (!state.opts.isMain(args)) {
    state.opts.log(`ignoring stale ${LOCK_NAME} (pid ${pid} is not OpenCode main)`)
    return
  }
  b.inflight.add(pid)
  await attemptInject(state, pid)
}

/** @param {AutoState} state */
function scheduleCheck(state) {
  if (state.debounce) clearTimeout(state.debounce)
  state.debounce = setTimeout(() => {
    state.debounce = null
    run(state, () => check(state))
  }, state.opts.debounceMs)
  state.debounce.unref?.()
}

/**
 * (Re)create the userData watcher; falls back to the existence poll on
 * error. Runs one immediate check so an already-running Desktop is caught.
 * @param {AutoState} state
 */
function startWatcher(state) {
  if (state.stopped || state.watcher) return
  if (!fs.existsSync(state.opts.userDataDir)) return
  try {
    state.watcher = fs.watch(state.opts.userDataDir, { persistent: false }, (_event, filename) => {
      run(state, () => {
        if (filename != null && filename !== LOCK_NAME) return
        scheduleCheck(state)
      })
    })
  } catch (err) {
    state.opts.log(`watch failed on ${state.opts.userDataDir}: ${errMsg(err)}`)
    state.watcher = null
    return
  }
  state.watcher.on("error", (err) => {
    run(state, () => {
      state.opts.log(`watch error on ${state.opts.userDataDir}: ${errMsg(err)} — falling back to polling`)
      try {
        state.watcher?.close()
      } catch {
        // already closed
      }
      state.watcher = null
    })
  })
  run(state, () => check(state))
}

/** @param {AutoState} state */
function start(state) {
  startWatcher(state)
  // Poll for the userData dir appearing (first Desktop launch after install)
  // and as a fallback if the watcher ever dies.
  state.poll = setInterval(() => {
    run(state, () => {
      if (!state.watcher) startWatcher(state)
    })
  }, state.opts.existPollMs)
  state.poll.unref?.()
}

/** @param {AutoState} state */
function stop(state) {
  state.stopped = true
  const g = /** @type {any} */ (globalThis)
  if (g[STATE_KEY] === state) g[STATE_KEY] = undefined
  if (state.debounce) clearTimeout(state.debounce)
  if (state.poll) clearInterval(state.poll)
  if (state.watcher) {
    try {
      state.watcher.close()
    } catch {
      // already closed
    }
  }
}

/**
 * Acquire the shared auto-injector. Refcounted singleton: the first acquire
 * starts watching, the last release stops everything. Returns the release
 * cleanup the plugin host awaits on unload. No-ops on win32 / when the
 * userData dir is not applicable.
 *
 * The `inject`, `argsOf`, `userDataDir`, `platform`, `enabled` and timing
 * options exist so tests can run the whole state machine against a temp dir
 * without touching a real process.
 * @param {AutoOptions} [options]
 * @returns {() => void}
 */
export function acquire(options = {}) {
  const g = /** @type {any} */ (globalThis)
  /** @type {AutoState | undefined} */
  let state = g[STATE_KEY]
  if (!state) {
    const platform = options.platform ?? process.platform
    const userDataDir = options.userDataDir ?? desktopUserDataDir(platform, process.env, os.homedir())
    const log = options.log ?? defaultLog()
    if (platform === "win32" || userDataDir === undefined) {
      return () => {}
    }
    /** @type {Required<AutoOptions>} */
    const opts = {
      log,
      userDataDir,
      platform,
      inject: options.inject ?? ((pid) => attachAndInject({ pid, warn: (m) => log(`inject: ${m}`) })),
      argsOf: options.argsOf ?? processArgs,
      isMain: options.isMain ?? ((args) => isOpenCodeMainArgs(args, platform)),
      enabled:
        options.enabled ??
        (() => config.readSettings({ configDir: config.configDir(), home: os.homedir() }).autoInject),
      settleMs: options.settleMs ?? SETTLE_MS,
      debounceMs: options.debounceMs ?? DEBOUNCE_MS,
      existPollMs: options.existPollMs ?? EXIST_POLL_MS,
      retryDelays: options.retryDelays ?? RETRY_DELAYS_MS,
    }
    state = { refs: 0, stopped: false, opts, watcher: null, debounce: null, poll: null }
    g[STATE_KEY] = state
    run(state, () => {
      log(`auto-inject watching ${userDataDir}`)
      start(state)
    })
  }
  state.refs++
  let released = false
  return () => {
    if (released) return
    released = true
    state.refs--
    if (state.refs <= 0) stop(state)
  }
}

/**
 * Test hook: drop all module-global state (running watcher + bookkeeping)
 * so each test starts clean.
 */
export function resetAutoInjectForTests() {
  const g = /** @type {any} */ (globalThis)
  const state = /** @type {AutoState | undefined} */ (g[STATE_KEY])
  if (state) stop(state)
  g[BOOK_KEY] = undefined
}
