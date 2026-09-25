// @ts-check
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  acquire,
  resetAutoInjectForTests,
  desktopUserDataDir,
  parseSingletonLock,
  isOpenCodeMainArgs,
} from "./auto.mjs"

const MAC_MAIN = "/Applications/OpenCode.app/Contents/MacOS/OpenCode"
const HOME = "/home/me"

test("desktopUserDataDir maps platforms", () => {
  assert.equal(
    desktopUserDataDir("darwin", {}, HOME),
    path.join(HOME, "Library", "Application Support", "ai.opencode.desktop"),
  )
  assert.equal(desktopUserDataDir("linux", { XDG_CONFIG_HOME: "/xdg" }, HOME), path.join("/xdg", "ai.opencode.desktop"))
  assert.equal(desktopUserDataDir("linux", {}, HOME), path.join(HOME, ".config", "ai.opencode.desktop"))
  assert.equal(desktopUserDataDir("win32", {}, HOME), undefined)
})

test("parseSingletonLock takes the pid after the last dash", () => {
  assert.equal(parseSingletonLock("Mac.lan-52988"), 52988)
  assert.equal(parseSingletonLock("my-host-name-123"), 123)
  assert.equal(parseSingletonLock("host-0"), null)
  assert.equal(parseSingletonLock("host-abc"), null)
  assert.equal(parseSingletonLock(""), null)
  assert.equal(parseSingletonLock(null), null)
})

test("isOpenCodeMainArgs identifies the main process only", () => {
  assert.equal(isOpenCodeMainArgs(MAC_MAIN, "darwin"), true)
  assert.equal(isOpenCodeMainArgs(`${HOME}/Applications/OpenCode.app/Contents/MacOS/OpenCode`, "darwin"), true)
  assert.equal(isOpenCodeMainArgs(`${MAC_MAIN} --some-flag`, "darwin"), true)
  assert.equal(isOpenCodeMainArgs(`${MAC_MAIN} --type=renderer`, "darwin"), false)
  assert.equal(isOpenCodeMainArgs("/opt/OpenCode/ai.opencode.desktop", "linux"), true)
  assert.equal(isOpenCodeMainArgs("/opt/OpenCode/ai.opencode.desktop --type=gpu-process", "linux"), false)
  assert.equal(isOpenCodeMainArgs("/usr/bin/ai.opencode.desktop", "linux"), true)
  assert.equal(isOpenCodeMainArgs("/usr/bin/something-else", "linux"), false)
  assert.equal(isOpenCodeMainArgs(MAC_MAIN, "win32"), false)
  assert.equal(isOpenCodeMainArgs(null, "darwin"), false)
})

const wait = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Acquire the auto-injector against a temp userData dir with fake process
 * lookups — nothing real is ever signaled.
 * @param {string} dir
 * @param {Map<number, string | null>} procs
 * @param {number[]} calls
 */
function acquireFake(dir, procs, calls) {
  return acquire({
    platform: "darwin",
    userDataDir: dir,
    log: () => {},
    enabled: () => true,
    argsOf: (pid) => procs.get(pid) ?? null,
    inject: async (pid) => {
      calls.push(pid)
    },
    settleMs: 5,
    debounceMs: 10,
    existPollMs: 60000,
    retryDelays: [20, 40, 80],
  })
}

const lock = (/** @type {string} */ dir, /** @type {number} */ pid) =>
  fs.symlinkSync(`test-host-${pid}`, path.join(dir, "SingletonLock"))

const unlock = (/** @type {string} */ dir) => {
  try {
    fs.unlinkSync(path.join(dir, "SingletonLock"))
  } catch {
    // absent
  }
}

test("auto-inject: initial check injects an already-running Desktop once", async () => {
  resetAutoInjectForTests()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bee-gee-auto-"))
  const procs = new Map([[4321, MAC_MAIN]])
  const calls = /** @type {number[]} */ ([])
  lock(dir, 4321)
  const release = acquireFake(dir, procs, calls)
  await wait(400)
  assert.deepEqual(calls, [4321])
  // repeat lock events for the same pid do not re-inject
  unlock(dir)
  lock(dir, 4321)
  await wait(400)
  assert.deepEqual(calls, [4321])
  release()
  resetAutoInjectForTests()
})

test("auto-inject: lock creation triggers inject; stale pids are ignored", async () => {
  resetAutoInjectForTests()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bee-gee-auto-"))
  const procs = new Map([[4321, MAC_MAIN]])
  const calls = /** @type {number[]} */ ([])
  const release = acquireFake(dir, procs, calls)
  await wait(200)
  assert.deepEqual(calls, [])

  // stale lock: pid is not the OpenCode main process -> never signaled
  lock(dir, 9999)
  await wait(400)
  assert.deepEqual(calls, [])

  // real lock appears -> injects once
  unlock(dir)
  lock(dir, 4321)
  await wait(400)
  assert.deepEqual(calls, [4321])

  // app restarts: old pid dies, new pid on the lock -> injects again
  procs.delete(4321)
  procs.set(5555, MAC_MAIN)
  unlock(dir)
  lock(dir, 5555)
  await wait(400)
  assert.deepEqual(calls, [4321, 5555])
  release()
  resetAutoInjectForTests()
})

test("auto-inject: refcount keeps running until the last release", async () => {
  resetAutoInjectForTests()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bee-gee-auto-"))
  const procs = new Map([[4321, MAC_MAIN]])
  const calls = /** @type {number[]} */ ([])
  const release1 = acquireFake(dir, procs, calls)
  const release2 = acquireFake(dir, procs, calls)

  release1()
  lock(dir, 4321)
  await wait(400)
  assert.deepEqual(calls, [4321])

  release2()
  procs.set(7777, MAC_MAIN)
  unlock(dir)
  lock(dir, 7777)
  await wait(400)
  assert.deepEqual(calls, [4321])
  resetAutoInjectForTests()
})

test("auto-inject: no-op on win32", () => {
  resetAutoInjectForTests()
  const release = acquire({ platform: "win32", log: () => {} })
  assert.equal(typeof release, "function")
  release()
})
