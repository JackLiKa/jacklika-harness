/**
 * Serializes selected model-facing tool calls through the `tools/execute`
 * waterfall. Mounting this plugin next to `@deepseek-ai/dsh-tool-memory-filesystem`
 * prevents overlapping `wiki_write` executions from racing the same vault
 * without changing the memory tools themselves. With `crossProcessLock`
 * enabled, each serialized dispatch additionally acquires an `mkdir`-based
 * lock directory inside the vault root, so separate dsh processes cannot
 * interleave writes.
 * @module @deepseek-ai/dsh-memory-queue
 */

import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { resolveMemoryVaultRoot } from '@deepseek-ai/dsh-tool-memory-filesystem'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-queue'

/** Services required so the listener registers after the tool registry exists. */
export const inject = ['tools']

/** Lock directory name placed inside the vault root. */
const LOCK_DIR = '.memory-queue.lock'

/** Plugin configuration. */
export interface Config {
  /** Tool names whose dispatches run one-at-a-time in registration order. */
  toolNames?: string[]
  /**
   * Vault root that hosts the lock directory. Resolved per call with the same
   * rules as the memory tools: empty selects `<session cwd>/.dsh/memory/`, a
   * relative path anchors at the session workspace.
   */
  vaultRoot?: string
  /**
   * Acquire a lock directory in the vault root around each serialized
   * dispatch so separate processes cannot interleave matching tool calls.
   */
  crossProcessLock?: boolean
  /** A lock directory unrefreshed for this long counts as abandoned and is reclaimed. */
  lockStaleMs?: number
  /** Interval at which the holder refreshes the lock directory mtime. */
  lockHeartbeatMs?: number
  /** Give up waiting for a held lock after this many milliseconds. */
  lockTimeoutMs?: number
  /** Delay between lock acquisition attempts. */
  lockRetryMs?: number
}

/** Schemastery configuration for the memory queue consumer. */
export const Config: z<Config> = z.object({
  toolNames: z.array(z.string()).default(['wiki_write']),
  vaultRoot: z.string().default(''),
  crossProcessLock: z.boolean().default(false),
  lockStaleMs: z.number().default(15000),
  lockHeartbeatMs: z.number().default(2000),
  lockTimeoutMs: z.number().default(30000),
  lockRetryMs: z.number().default(100),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`memory-queue: ${field} must be a positive integer`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Acquire the vault's lock directory, waiting for foreign holders and
 * reclaiming stale locks whose heartbeat stopped. The holder refreshes the
 * directory mtime every `lockHeartbeatMs`, so `lockStaleMs` only bounds
 * heartbeat loss — not dispatch duration — and a slow live write is never
 * reclaimed.
 * @param lockPath - absolute path of the lock directory.
 * @param resolved - applied plugin configuration.
 * @param signal - caller signal; an aborted caller fails instead of waiting.
 * @returns release callback that stops the heartbeat and removes the lock directory.
 */
async function acquireLock(
  lockPath: string,
  resolved: ResolvedConfig,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + resolved.lockTimeoutMs
  for (;;) {
    signal.throwIfAborted()
    try {
      await mkdir(lockPath)
      // Owner metadata is diagnostic only; never gate behavior on it.
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }), 'utf8').catch(() => undefined)
      const heartbeat = setInterval(() => {
        const now = new Date()
        utimes(lockPath, now, now).catch(() => undefined)
      }, resolved.lockHeartbeatMs)
      heartbeat.unref()
      return async () => {
        clearInterval(heartbeat)
        await rm(lockPath, { recursive: true, force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await stat(lockPath).catch(() => undefined)
      if (info !== undefined && Date.now() - info.mtimeMs > resolved.lockStaleMs) {
        // The holder's heartbeat stopped; reclaim and retry.
        await rm(lockPath, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`memory-queue: timed out waiting for vault lock ${lockPath}`)
      }
      await sleep(resolved.lockRetryMs)
    }
  }
}

/**
 * Register a `tools/execute` waterfall listener that serializes every call
 * whose name appears in `toolNames`. Non-matching calls pass straight through.
 * Queued calls respect the caller signal while waiting: an aborted caller
 * never dispatches. With `crossProcessLock`, the serialized section also
 * holds the vault lock directory so other processes cannot interleave.
 * @param ctx - registrant context carrying the tool registry events.
 * @param config - deployment's explicit queue configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (resolved.toolNames.length === 0) {
    throw new Error('memory-queue: toolNames must not be empty')
  }
  assertPositiveInteger('lockStaleMs', resolved.lockStaleMs)
  assertPositiveInteger('lockHeartbeatMs', resolved.lockHeartbeatMs)
  assertPositiveInteger('lockTimeoutMs', resolved.lockTimeoutMs)
  assertPositiveInteger('lockRetryMs', resolved.lockRetryMs)
  if (resolved.lockStaleMs <= resolved.lockHeartbeatMs * 2) {
    throw new Error('memory-queue: lockStaleMs must exceed twice lockHeartbeatMs so one missed heartbeat is not fatal')
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
      if (!resolved.crossProcessLock) return await next()
      const lockPath = join(resolveMemoryVaultRoot(resolved.vaultRoot, exec), LOCK_DIR)
      const unlock = await acquireLock(lockPath, resolved, exec.signal)
      try {
        return await next()
      } finally {
        await unlock()
      }
    } finally {
      release()
    }
  })
}
