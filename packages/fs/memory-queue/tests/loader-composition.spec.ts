import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
 * @returns the booted context.
 */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-queue-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-memory-queue'",
    '  config:',
    '    toolNames:',
    '      - slow_tool',
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

describe('memory-queue real Loader composition through cordis.yml', () => {
  it('runs matching tool dispatches one at a time', async () => {
    const ctx = await boot()
    const intervals: Interval[] = []
    registerSlowTool(ctx, intervals)

    const first = ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('slow-1'),
      name: 'slow_tool',
      arguments: { label: 'first' },
    })
    const second = ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('slow-2'),
      name: 'slow_tool',
      arguments: { label: 'second' },
    })
    const [r1, r2] = await Promise.all([first, second])
    expect(r1.isError).toBe(false)
    expect(r2.isError).toBe(false)

    const sorted = [...intervals].sort((a, b) => a.start - b.start)
    expect(sorted).toHaveLength(2)
    expect(sorted[1]!.start).toBeGreaterThanOrEqual(sorted[0]!.end)
  })
})
