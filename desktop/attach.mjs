// @ts-check
// Shared injection machinery for OpenCode Desktop, used by the
// `bee-gee-desktop` CLI (launch.mjs) and the in-service auto-injector
// (auto.mjs). Plain node builtins; must run under Node >=22 and Bun.
//
// The flow: open the app's devtools inspector (only on 127.0.0.1, only for
// the duration of the injection), evaluate desktop/injector.cjs inside the
// Electron main process, then close the inspector again. Nothing in the app
// bundle is modified.

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import config from "./config.cjs"

export const INSPECT_HOST = "127.0.0.1"
export const ATTACH_PORT = 9229
const APP_BUNDLE_ID = "ai.opencode.desktop"

export const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** @param {unknown} err */
const errMsg = (err) => (err instanceof Error ? err.message : String(err))

/**
 * Absolute path to the injector module evaluated inside the app.
 * @returns {string}
 */
export function injectorPath() {
  return fileURLToPath(new URL("./injector.cjs", import.meta.url))
}

/**
 * Default install() payload: the opencode CLI config dir (settings source),
 * the bundled wallpaper when present, and the shared injector log file.
 * @returns {{ configDir: string, bundledImage?: string, logFile: string }}
 */
export function defaultPayload() {
  const bundledImage = fileURLToPath(new URL("../assets/opencode-deepseek-theme.png", import.meta.url))
  return {
    configDir: config.configDir(),
    bundledImage: fs.existsSync(bundledImage) ? bundledImage : undefined,
    logFile: path.join(os.tmpdir(), "bee-gee", "desktop.log"),
  }
}

/**
 * Pid of the running OpenCode main process, or null. POSIX: `ps` rows whose
 * args are exactly the executable (Electron helpers carry --type= and are
 * skipped). Windows: tasklist image-name match (presence + pid).
 * @param {string} exe
 * @returns {number | null}
 */
export function findRunningPid(exe) {
  if (process.platform === "win32") {
    const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${path.basename(exe)}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
    })
    if (out.status !== 0 || !out.stdout) return null
    for (const line of out.stdout.split(/\r?\n/)) {
      const match = line.match(/^"[^"]+","(\d+)"/)
      if (match) return Number(match[1])
    }
    return null
  }
  const out = spawnSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" })
  if (out.status !== 0 || !out.stdout) {
    throw new Error("`ps -axo pid=,args=` failed; cannot detect a running OpenCode instance")
  }
  for (const line of out.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!match) continue
    const args = match[2]
    if (args.includes(" --type=")) continue
    if (args === exe || args.startsWith(`${exe} `)) return Number(match[1])
  }
  return null
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  if (process.platform === "win32") {
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" })
    return out.status === 0 && typeof out.stdout === "string" && out.stdout.includes(`"${pid}"`)
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Quit the running instance without force, then wait for it to exit.
 * @param {number} pid
 */
export async function gracefulQuit(pid) {
  if (process.platform === "darwin") {
    spawnSync("osascript", ["-e", `tell application id "${APP_BUNDLE_ID}" to quit`])
  } else if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid)])
  } else {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return
    await sleep(250)
  }
  throw new Error("OpenCode did not exit within 20s — quit it manually and re-run")
}

/**
 * @returns {Promise<number>} an ephemeral port on 127.0.0.1
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, INSPECT_HOST, () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * @param {number} port
 * @returns {Promise<any[]>}
 */
export async function debuggerTargets(port) {
  const res = await fetch(`http://${INSPECT_HOST}:${port}/json/list`)
  if (!res.ok) throw new Error(`inspector HTTP ${res.status}`)
  return /** @type {Promise<any[]>} */ (res.json())
}

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function debuggerReachable(port) {
  try {
    await debuggerTargets(port)
    return true
  } catch {
    return false
  }
}

/**
 * Poll the inspector target list until a debuggable target shows up.
 * @param {number} port
 * @param {number} timeoutMs
 * @param {import("node:child_process").ChildProcess | null} [child]
 * @param {() => Error | null} [spawnFailed]
 * @returns {Promise<string>} webSocketDebuggerUrl
 */
export async function waitForWsUrl(port, timeoutMs, child, spawnFailed) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const err = spawnFailed?.()
    if (err) throw new Error(`could not launch OpenCode: ${err.message}`)
    if (child && child.exitCode !== null) {
      throw new Error(
        `OpenCode exited (code ${child.exitCode}) before the inspector came up — ` +
          "another running instance probably holds the single-instance lock",
      )
    }
    try {
      const target = (await debuggerTargets(port)).find((t) => typeof t.webSocketDebuggerUrl === "string")
      if (target) return target.webSocketDebuggerUrl
    } catch {
      // inspector not up yet
    }
    await sleep(100)
  }
  throw new Error(`timed out waiting for the OpenCode inspector on ${INSPECT_HOST}:${port}`)
}

/**
 * Minimal CDP client over the global (undici) WebSocket: id counter, pending
 * map, 15s per-call timeout, reject everything on close.
 * @param {string} wsUrl
 * @returns {Promise<{ send: (method: string, params?: any) => Promise<any>, close: () => void }>}
 */
export function connectDebugger(wsUrl) {
  const WebSocketCtor = /** @type {any} */ (globalThis).WebSocket
  return new Promise((resolve, reject) => {
    const ws = new WebSocketCtor(wsUrl)
    let nextId = 0
    /** @type {Map<number, { resolve: (value: any) => void, reject: (err: Error) => void, timer: NodeJS.Timeout }>} */
    const pending = new Map()
    const rejectAll = (/** @type {Error} */ err) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      pending.clear()
    }
    const client = {
      send(/** @type {string} */ method, /** @type {any} */ params) {
        const id = ++nextId
        return new Promise((resolveCall, rejectCall) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            rejectCall(new Error(`debugger call ${method} timed out`))
          }, 15000)
          pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
          ws.send(JSON.stringify({ id, method, params }))
        })
      },
      close() {
        try {
          ws.close()
        } catch {
          // already closed
        }
      },
    }
    ws.addEventListener("open", () => resolve(client))
    ws.addEventListener("message", (/** @type {{ data: any }} */ event) => {
      /** @type {any} */
      let msg
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message || "debugger error"))
      else p.resolve(msg.result)
    })
    ws.addEventListener("close", () => {
      const err = new Error("debugger connection closed")
      rejectAll(err)
      reject(err)
    })
    ws.addEventListener("error", () => reject(new Error(`could not connect to the OpenCode inspector (${wsUrl})`)))
  })
}

/**
 * Runtime.evaluate with awaitPromise + returnByValue; exceptionDetails
 * becomes an Error.
 * @param {{ send: (method: string, params?: any) => Promise<any> }} cdp
 * @param {string} expression
 * @returns {Promise<any>}
 */
export async function evaluate(cdp, expression) {
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) {
    const ex = res.exceptionDetails.exception
    const detail = ex?.description || ex?.value || res.exceptionDetails.text
    throw new Error(`in-app evaluation failed: ${detail}`)
  }
  return res.result?.value
}

/**
 * Expression evaluated in the Electron main process: a fresh require rooted
 * at the injector path (cache under the desktop dir is dropped so re-runs
 * pick up new code), then install().
 * @param {string} injector
 * @param {string} desktopPrefix
 * @param {any} payload
 * @returns {string}
 */
export function injectionExpression(injector, desktopPrefix, payload) {
  return `(() => {
  const req = process.getBuiltinModule("module").createRequire(${JSON.stringify(injector)})
  for (const key of Object.keys(req.cache)) {
    if (key.startsWith(${JSON.stringify(desktopPrefix)})) delete req.cache[key]
  }
  return req(${JSON.stringify(injector)}).install(${JSON.stringify(payload)})
})()`
}

/**
 * Inject, verify the install result, then shut the inspector back down.
 * @param {{ send: (method: string, params?: any) => Promise<any>, close: () => void }} cdp
 * @param {number} port
 * @param {string} injector
 * @param {any} payload
 * @param {(message: string) => void} warn
 * @returns {Promise<any>} the injector's install() result
 */
export async function injectAndClose(cdp, port, injector, payload, warn) {
  const desktopPrefix = path.dirname(injector) + path.sep
  const result = await evaluate(cdp, injectionExpression(injector, desktopPrefix, payload))
  if (result?.locked !== true) {
    throw new Error(
      "the attached process does not hold the single-instance lock — this looks like an exiting secondary instance, aborting",
    )
  }
  try {
    await evaluate(cdp, 'setTimeout(() => process.getBuiltinModule("inspector").close(), 200); true')
  } catch (err) {
    warn(`could not schedule inspector shutdown: ${errMsg(err)}`)
  } finally {
    // inspector.close() blocks until every session disconnects, so the
    // socket must go first and the app-side close runs on a timer.
    cdp.close()
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    await sleep(200)
    if (!(await debuggerReachable(port))) return result
  }
  warn(`inspector on ${INSPECT_HOST}:${port} is still open — it will close on the next app restart`)
  return result
}

/**
 * ATTACH path: flip on the inspector of a running instance with SIGUSR1
 * (the app enables nodeCliInspect), verify the answering pid is the one we
 * signaled, inject, then close the inspector.
 * @param {{ pid: number, warn?: (message: string) => void, injector?: string, payload?: any }} input
 * @returns {Promise<any>} the injector's install() result
 */
export async function attachAndInject(input) {
  const warn = input.warn ?? (() => {})
  const injector = input.injector ?? injectorPath()
  const payload = input.payload ?? defaultPayload()
  if (await debuggerReachable(ATTACH_PORT)) {
    throw new Error(`port ${ATTACH_PORT} already has a debugger; refusing to inject`)
  }
  try {
    process.kill(input.pid, "SIGUSR1")
  } catch (err) {
    throw new Error(`could not signal OpenCode (pid ${input.pid}): ${errMsg(err)}`)
  }
  const wsUrl = await waitForWsUrl(ATTACH_PORT, 10000)
  const cdp = await connectDebugger(wsUrl)
  try {
    const actual = await evaluate(cdp, "process.pid")
    if (actual !== input.pid) {
      throw new Error(`inspector answered for pid ${actual}, expected ${input.pid} — refusing to inject`)
    }
    return await injectAndClose(cdp, ATTACH_PORT, injector, payload, warn)
  } finally {
    cdp.close()
  }
}

/**
 * LAUNCH path: start the app with a temporary inspector on a free port,
 * inject, close the inspector. stdio is ignored on purpose — a pipe closed
 * after we exit would EPIPE the app.
 * @param {{ exe: string, extra?: string[], warn?: (message: string) => void, injector?: string, payload?: any }} input
 * @returns {Promise<import("node:child_process").ChildProcess>} the spawned app process
 */
export async function launchAndInject(input) {
  const warn = input.warn ?? (() => {})
  const injector = input.injector ?? injectorPath()
  const payload = input.payload ?? defaultPayload()
  const port = await freePort()
  const child = spawn(input.exe, [`--inspect=${INSPECT_HOST}:${port}`, ...(input.extra ?? [])], {
    detached: true,
    stdio: "ignore",
  })
  // An async spawn failure (EACCES etc.) surfaces as an 'error' event —
  // keep it so the poll below can report it instead of timing out.
  let spawnError = /** @type {Error | null} */ (null)
  child.once("error", (err) => {
    spawnError = err
  })
  child.unref()
  const wsUrl = await waitForWsUrl(port, 30000, child, () => spawnError)
  const cdp = await connectDebugger(wsUrl)
  try {
    await injectAndClose(cdp, port, injector, payload, warn)
  } finally {
    cdp.close()
  }
  return child
}
