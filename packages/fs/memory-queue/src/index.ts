/**
 * Serializes selected model-facing tool calls through the `tools/execute`
 * waterfall. Mounting this plugin next to `@deepseek-ai/dsh-tool-memory-filesystem`
 * prevents overlapping `wiki_write` executions from racing the same vault
 * without changing the memory tools themselves.
 * @module @deepseek-ai/dsh-memory-queue
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-queue'

/** Services required so the listener registers after the tool registry exists. */
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** Tool names whose dispatches run one-at-a-time in registration order. */
  toolNames?: string[]
}

/** Schemastery configuration for the memory queue consumer. */
export const Config: z<Config> = z.object({
  toolNames: z.array(z.string()).default(['wiki_write']),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/**
 * Register a `tools/execute` waterfall listener that serializes every call
 * whose name appears in `toolNames`. Non-matching calls pass straight through.
 * Queued calls respect the caller signal while waiting: an aborted caller
 * never dispatches.
 * @param ctx - registrant context carrying the tool registry events.
 * @param config - deployment's explicit queue configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (resolved.toolNames.length === 0) {
    throw new Error('memory-queue: toolNames must not be empty')
  }
  const names = new Set(resolved.toolNames)
  let tail: Promise<void> = Promise.resolve()

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    if (!names.has(exec.name)) return next()
    const previous = tail
    let release = (): void => undefined
    tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    exec.signal.throwIfAborted()
    try {
      return await next()
    } finally {
      release()
    }
  })
}
