/**
 * dsh-session-keepwarm — host half.
 *
 * The behaviour is entirely browser-side (it holds client Session references);
 * the host half exists so the bundle has a loadable entry, and it carries the
 * Config schema the settings form is derived from.
 *
 * @module dsh-session-keepwarm
 */

import z from '@deepseek-ai/schemastery'

/** The profile entry id; the client half reads the same form via `configForms`. */
export const SESSION_KEEPWARM_NS = 'session-keepwarm'

/** Cordis plugin name. */
export const name = 'session-keepwarm'

/**
 * Volatile fields: the settings form derives from this schema and the Loader
 * commits edits into the running references, so the client half reads live
 * values through its `ConfigForm` subscription.
 */
export const Config = z.object({
  /** Master switch; off drops every held reference. */
  enabled: z.boolean().default(true).volatile(),
  /** How many recently used sessions stay resident. */
  keepWarm: z.natural().min(1).max(20).default(5).volatile(),
})

/** Host half is intentionally empty. */
export function apply() {}
