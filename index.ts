// Server entry. Zero npm imports on purpose: this file loads under the
// server's module resolver without node_modules, so only relative imports
// and node builtins are allowed.
//
// Besides satisfying the plugin contract it hosts the Desktop
// auto-injector: the opencode background service instantiates this plugin
// per location, and acquire() is a refcounted singleton, so repeated
// setup/cleanup share (and eventually stop) one SingletonLock watcher.
// Any failure must degrade to a no-op cleanup — never fail plugin load.
export default {
  id: "bee-gee",
  async setup() {
    if (process.platform === "win32") return () => {}
    try {
      const { acquire } = await import("./desktop/auto.mjs")
      return acquire()
    } catch (err) {
      console.error("bee-gee: desktop auto-inject failed to start:", err)
      return () => {}
    }
  },
}
