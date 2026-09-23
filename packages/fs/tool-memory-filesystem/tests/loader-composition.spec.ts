import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory-filesystem'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml carrying the memory-filesystem tool and a vault directory.
 * @param vaultRoot - absolute path to the vault root.
 * @returns the booted context.
 */
async function boot(vaultRoot: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-memory-filesystem'",
    '  config:',
    `    vaultRoot: ${vaultRoot}`,
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
    ['@deepseek-ai/dsh-tool-memory-filesystem', ToolMemory],
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

async function makeVault(): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-vault-'))
  const concepts = join(vaultRoot, 'concepts')
  await mkdir(concepts)
  await writeFile(join(concepts, 'RAG.md'), '---\ntags: [llm, architecture]\n---\n\n# Retrieval-Augmented Generation\n\nRAG combines [[embedding]] retrieval with LLM generation.\n')
  await writeFile(join(vaultRoot, 'embedding.md'), '---\ntags: [llm]\n---\n\n# Embedding\n\nAn embedding is a dense vector. See also [[concepts/RAG]].\n')
  return vaultRoot
}

describe('tool-memory-filesystem real Loader composition through cordis.yml', () => {
  it('exposes wiki_read, wiki_search, and wiki_write tools with expected schemas', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const names = ctx.tools.schemas().map(s => s.name).sort()
    expect(names).toContain('wiki_read')
    expect(names).toContain('wiki_search')
    expect(names).toContain('wiki_write')
  })

  it('reads a note and follows Obsidian-style links', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('read-rag'),
      name: 'wiki_read',
      arguments: { id: 'concepts/RAG.md' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected wiki_read success')
    const note = JSON.parse(resultText(result)) as { id: string; links: string[]; linkedNotes: unknown[] }
    expect(note.id).toBe('concepts/RAG.md')
    expect(note.links).toContain('embedding')
    expect(note.linkedNotes).toHaveLength(1)
  })

  it('searches notes by keyword', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('search-rag'),
      name: 'wiki_search',
      arguments: { query: 'RAG' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected wiki_search success')
    const hits = JSON.parse(resultText(result)) as { id: string }[]
    expect(hits.some(h => h.id === 'concepts/RAG.md')).toBe(true)
    expect(hits.some(h => h.id === 'embedding.md')).toBe(true)
  })

  it('appends to a note while preserving frontmatter', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const writeResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('write-rag'),
      name: 'wiki_write',
      arguments: { id: 'concepts/RAG.md', content: 'New insight.' },
    })
    expect(writeResult.isError).toBe(false)
    if (writeResult.isError) throw new Error('expected wiki_write success')

    const readResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('read-rag-after-write'),
      name: 'wiki_read',
      arguments: { id: 'concepts/RAG.md' },
    })
    expect(readResult.isError).toBe(false)
    if (readResult.isError) throw new Error('expected wiki_read success')
    const note = JSON.parse(resultText(readResult)) as { body: string; frontmatter: Record<string, unknown> }
    expect(note.body).toContain('New insight.')
    expect(note.frontmatter.tags).toEqual(['llm', 'architecture'])
  })

  it('rejects paths outside the vault root', async () => {
    const vault = await makeVault()
    const ctx = await boot(vault)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('escape-attempt'),
      name: 'wiki_read',
      arguments: { id: '../embedding.md' },
    })
    expect(result.isError).toBe(true)
  })
})
