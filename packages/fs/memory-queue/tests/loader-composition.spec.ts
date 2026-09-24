import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as ToolMemoryQueue from '@deepseek-ai/dsh-memory-queue'
import * as ToolMemoryFilesystem from '@deepseek-ai/dsh-tool-memory-filesystem'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the memory-queue plugin configured to serialize
 * the test tool.
 * @param extraConfig - extra YAML lines appended under the plugin's `config:`.
 * @returns the booted context.
 */
async function boot(extraConfig: string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-queue-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-memory-queue'",
    '  config:',
    '    toolNames:',
    '      - slow_tool',
    ...extraConfig,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-memory-queue', ToolMemoryQueue],
    ['@deepseek-ai/dsh-tool-memory-filesystem', ToolMemoryFilesystem],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

interface Interval { label: string; start: number; end: number }

function registerSlowTool(ctx: Context, intervals: Interval[]): void {
  ctx.tools.register(defineTool({
    name: 'slow_tool',
    description: 'Records its dispatch interval for serialization tests.',
    parameters: {
      label: { type: 'string', required: true, description: 'Interval label.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const start = Date.now()
      await new Promise(resolve => setTimeout(resolve, 60))
      const end = Date.now()
      intervals.push({ label: args.label, start, end })
      return { label: args.label }
    },
  }))
}

function call(ctx: Context, callId: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'slow_tool',
    arguments: { label: callId },
  })
}

describe('memory-queue real Loader composition through cordis.yml', () => {
  it('runs matching tool dispatches one at a time', async () => {
    const ctx = await boot()
    const intervals: Interval[] = []
    registerSlowTool(ctx, intervals)

    const [r1, r2] = await Promise.all([call(ctx, 'first'), call(ctx, 'second')])
    expect(r1.isError).toBe(false)
    expect(r2.isError).toBe(false)

    const sorted = [...intervals].sort((a, b) => a.start - b.start)
    expect(sorted).toHaveLength(2)
    expect(sorted[1]!.start).toBeGreaterThanOrEqual(sorted[0]!.end)
  })

  it('acquires and releases the vault lock directory when crossProcessLock is on', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-queue-vault-'))
    const ctx = await boot([
      '    crossProcessLock: true',
      `    vaultRoot: ${vault}`,
    ])
    const intervals: Interval[] = []
    registerSlowTool(ctx, intervals)

    const result = await call(ctx, 'locked')
    expect(result.isError).toBe(false)
    await expect(stat(join(vault, '.memory-queue.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims a stale foreign lock and fails fast on a fresh one', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-queue-vault-'))
    const ctx = await boot([
      '    crossProcessLock: true',
      `    vaultRoot: ${vault}`,
      '    lockStaleMs: 500',
      '    lockTimeoutMs: 200',
      '    lockRetryMs: 20',
    ])
    const intervals: Interval[] = []
    registerSlowTool(ctx, intervals)

    // A lock left by a dead process: older than lockStaleMs, so it is reclaimed.
    const lockPath = join(vault, '.memory-queue.lock')
    await mkdir(lockPath)
    const old = new Date(Date.now() - 60000)
    await utimes(lockPath, old, old)
    const reclaimed = await call(ctx, 'reclaim')
    expect(reclaimed.isError).toBe(false)

    // A lock held by a live foreign process: fresh mtime, never released.
    await mkdir(lockPath)
    const blocked = await call(ctx, 'blocked')
    expect(blocked.isError).toBe(true)
    await rm(lockPath, { recursive: true, force: true })
  })
})
