/**
 * dsh-session-keepwarm — client half.
 *
 * DSH 0.1.7's client keeps a session resident only while a `SessionReference`
 * is outstanding: a main-view switch releases the outgoing session, the last
 * release tears down that generation's local data (history window, scoped
 * Context, history stream), and switching back rebuilds it by re-reading the
 * first history page ("载入历史"). This plugin holds one extra reference per
 * recently used session — under its own source key `sessionKeepwarm` — so the
 * last release never fires for those sessions and switching back reuses the
 * resident window. The set is an LRU capped by the `keepWarm` setting.
 *
 * Scope and boundaries:
 * - Only plain sessions are held; subagent rows keep their own lifecycle.
 * - References are per page context: this warms switches inside one tab. A
 *   second tab or browser has its own heap and references (the client shares
 *   no session state across tabs), so it still loads on first open.
 * - Holding a reference keeps client-local data and the history stream only;
 *   it never starts or holds a Host Agent.
 * - `enabled: false` drops every held reference; changing `keepWarm` trims
 *   the LRU immediately.
 *
 * Bundle contract: `@deepseek-ai/dsh-client-modules` executes a client bundle
 * only to REGISTER its factory (`window.__ModuleLoader__.load({id, factory})`);
 * the body must live inside the factory, and the factory MUST return
 * module.exports — materialize() takes the factory return value as the plugin
 * exports.
 */

window.__ModuleLoader__.load({ id: 'dsh-session-keepwarm', factory: () => {
  var module = { exports: {} }
  var exports = module.exports

  /** Services required by the keep-warm loop. */
  const inject = ['sessions', 'configForms']

  /** Profile entry id whose config form carries `enabled` and `keepWarm`. */
  const NS = 'session-keepwarm'

  /**
   * Reference-source key this plugin's references are counted under. The
   * controller keeps only positive source counts, so the key shows up as
   * `retainedBy.sessionKeepwarm` while something is held.
   */
  const SOURCE = 'sessionKeepwarm'

  /** Bounds mirrored from the host schema; the form is authoritative. */
  const DEFAULT_LIMIT = 5
  const MIN_LIMIT = 1
  const MAX_LIMIT = 20

  /**
   * Mount the keep-warm loop.
   * @param ctx - client plugin context.
   */
  function apply(ctx) {
    const sessions = ctx.sessions
    const form = ctx.configForms.get(NS)

    let enabled = true
    let limit = DEFAULT_LIMIT

    /** session id -> held reference. */
    const held = new Map()
    /** Ids whose `retain` call is still on the stack; see `hold`. */
    const holding = new Set()
    /** LRU order, most recently active first. */
    const warm = []
    /** Ids that carried a mainView reference in the previous list snapshot. */
    let active = new Set()
    /** Re-entrancy guard and pending-rerun flag for `sync`. */
    let syncing = false
    let dirty = false
    /** Whether a subscription burst already queued one deferred reconcile. */
    let scheduled = false

    /** Read the live form snapshot; failures fall back to the defaults. */
    const readConfig = () => {
      let value
      try { value = form.getSnapshot().value } catch (error) { value = undefined }
      const raw = value === null || value === undefined ? {} : value
      enabled = raw.enabled !== false
      const wanted = Number(raw.keepWarm)
      limit = Number.isFinite(wanted)
        ? Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(wanted)))
        : DEFAULT_LIMIT
    }

    /** Release one held reference, if any. */
    const drop = (id) => {
      const reference = held.get(id)
      if (reference === undefined) return
      held.delete(id)
      try {
        reference.release()
      } catch (error) {
        console.error('[session-keepwarm] release failed:', id, error)
      }
    }

    /** Drop everything and forget the LRU order. */
    const dropAll = () => {
      for (const id of [...held.keys()]) drop(id)
      warm.length = 0
    }

    /**
     * Acquire one reference and keep unhandled open rejections off the console.
     *
     * `sessions.retain` publishes to `sessions.list` synchronously, so the list
     * subscriber can re-enter this call before it returns; the in-flight marker
     * must therefore be set before `retain`, not after it.
     */
    const hold = (id) => {
      if (held.has(id) || holding.has(id)) return
      holding.add(id)
      try {
        const reference = sessions.retain(id, { source: SOURCE })
        held.set(id, reference)
        // A failed initial open rejects `ready`; the visible session already
        // reports it, and an unheld `ready` must not surface as unhandled.
        void reference.ready.catch(() => {})
      } catch (error) {
        console.error('[session-keepwarm] retain failed:', id, error)
      } finally {
        holding.delete(id)
      }
    }

    /** Enforce the configured cap over the LRU tail. */
    const trim = () => {
      if (!enabled) return
      while (warm.length > limit) {
        const evicted = warm.pop()
        if (evicted !== undefined) drop(evicted)
      }
    }

    /** Mark one session as most recently used and keep it resident. */
    const touch = (id) => {
      const index = warm.indexOf(id)
      if (index !== -1) warm.splice(index, 1)
      warm.unshift(id)
      if (enabled) hold(id)
      trim()
    }

    /** Reconcile the LRU with the list snapshot once. */
    const reconcile = () => {
      if (!enabled) {
        dropAll()
        active = new Set()
        return
      }
      let state
      try { state = sessions.list.getSnapshot() } catch (error) { return }
      const now = new Set()
      for (const id of state.ids) {
        const row = state.byId[id]
        // Subagent fallbacks carry `parentId` and keep their own lifecycle.
        if (row === undefined || row.parentId !== undefined) continue
        if ((row.retainedBy.mainView ?? 0) > 0) now.add(id)
      }
      // The outgoing session keeps `mainView` until the incoming one is bound;
      // a new id appearing here is the switch, and the old one stays warm.
      for (const id of now) if (!active.has(id)) touch(id)
      active = now
      trim()
    }

    /**
     * Reconcile under a re-entrancy guard: holding a reference publishes to the
     * session list, so a reconcile can run inside another one. A suppressed call
     * marks the state dirty and the running call reconciles again once it can.
     */
    const sync = () => {
      if (syncing) { dirty = true; return }
      syncing = true
      try {
        do {
          dirty = false
          reconcile()
        } while (dirty)
      } finally {
        syncing = false
      }
    }

    /**
     * Defer one reconcile out of the notification stack that asked for it.
     * Retaining inside the publisher's own notify loop is what makes the
     * keep-warm loop re-enter itself; a microtask keeps publishers and
     * subscribers in separate stacks, and bursts collapse into one reconcile.
     */
    const schedule = () => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        try { sync() } catch (error) { console.error('[session-keepwarm] sync failed:', error) }
      })
    }

    readConfig()
    ctx.effect(() => form.subscribe(() => { readConfig(); schedule() }), 'session-keepwarm: config')
    ctx.effect(() => sessions.list.subscribe(() => { schedule() }), 'session-keepwarm: session list')
    ctx.effect(() => () => { dropAll() }, 'session-keepwarm: teardown')
    sync()
  }

  module.exports = { inject, apply }
  return module.exports
}})
