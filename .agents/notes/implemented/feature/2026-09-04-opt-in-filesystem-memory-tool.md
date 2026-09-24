# Agent Note: Opt-in filesystem-backed wiki/memory tool

Status: implemented

English | [中文](2026-09-04-opt-in-filesystem-memory-tool.zh.md)

## Problem

dsh has a rich event-sourced session memory, but no long-term, user-owned knowledge store. Users who keep project knowledge in an Obsidian-style Markdown vault wanted the agent to read, search, and append notes without replacing the core session architecture. The change had to follow the Open/Closed Principle: extend the harness with a new storage option instead of modifying the existing memory core.

## Decision

Introduce `@deepseek-ai/dsh-tool-memory-filesystem`, a Cordis plugin in `packages/fs/tool-memory-filesystem/` that registers three model-facing tools:

- `wiki_read(id)` — read one Markdown note, parse YAML frontmatter, and follow Obsidian-style `[[link]]` references up to a configured depth.
- `wiki_search(query)` — keyword search across note titles, ids, and bodies; results include backlink counts.
- `wiki_write(id, content, mode?)` — create or append to a note. Append mode preserves frontmatter and adds a timestamp header.

The plugin is opt-in: a profile patch mounts it, optionally setting `vaultRoot`:

```yaml
- name: '@deepseek-ai/dsh-tool-memory-filesystem'
```

Without `vaultRoot`, each tool call resolves the vault to `<session cwd>/.dsh/memory/`, so every project workspace owns an isolated memory store; an explicit `vaultRoot` pins one shared vault, with relative paths anchored at the session workspace. When the plugin is absent, default session memory behavior is unchanged.

## Alternatives considered

**Modify `dsh-session-persistence-jsonl` or `dsh-tool-fs` to speak Markdown/Obsidian.** Rejected: it would couple session persistence or generic filesystem tools to one knowledge representation and would not let users choose a different backend later.

**Introduce a full `ctx.memory` capability seam with providers in the first PR.** Rejected: the user explicitly asked for an MVP. A seam is the right long-term shape, but starting with one concrete tool package keeps the change small and proves the user-facing contract before abstracting it.

**Implement vector/RAG search in the MVP.** Rejected: the user noted that vector retrieval has inherent limitations in many scenarios and preferred a simple keyword/link approach first. The separate `tool-memory-vector` package now provides opt-in embedding retrieval without touching this one.

## Companion packages

Three opt-in packages extend the vault without modifying this plugin:

- `@deepseek-ai/dsh-tool-memory-graph` — `wiki_graph` returns the vault's `[[link]]` node/edge graph or a note-centered subgraph, reusing this package's parsing helpers.
- `@deepseek-ai/dsh-memory-scope` — rewrites `wiki_write` (configurable) ids to `agents/<agent key>/<id>` through the `tools/execute` waterfall via nested re-dispatch, so agents cannot collide on the same note by construction; `shared/` prefixes stay unscoped for queue or curator arbitration, and `role: curator` disables rewriting for consolidator deployments.
- `@deepseek-ai/dsh-memory-queue` — serializes `wiki_write` (configurable) dispatches through the `tools/execute` waterfall for single-writer ordering; an optional `crossProcessLock` holds an `mkdir` lock directory in the vault root whose liveness is proven by change detection on a heartbeat counter file (directory mtime for legacy locks without one) measured on the waiter's local clock, so separate dsh processes cannot interleave writes, slow writes are never reclaimed, and cross-machine clock skew cannot fake staleness. `wiki_write` publishes atomically via temp file + `rename`; `wiki_read` returns a `version` fingerprint that `wiki_write` accepts as optional `baseVersion` to fail loudly when an uncoordinated writer changed the note between read and write.
- `@deepseek-ai/dsh-memory-git` — commits each successful `wiki_write` (configurable, `shared/` prefixes by default) to a vault git repository through the `tools/execute` waterfall for version history, rollback, and audit; mounted after the queue, commits run inside the vault lock.
- `@deepseek-ai/dsh-tool-memory-vector` — `wiki_semantic_search` ranks notes by cosine similarity over embeddings from a configurable OpenAI-compatible endpoint, with a per-vault mtime-keyed `.vector-index.json` cache.

An `indexHiddenDirs` config flag (default `false`) lets a deployment whose `vaultRoot` is the workspace root index `.dsh/memory/` notes while keeping `.git`/`node_modules` excluded.

## Consequences

- The existing session event log and JSONL persistence remain untouched.
- Users can point any profile at a Markdown vault and immediately get `wiki_read`/`wiki_search`/`wiki_write`.
- The package is placed in `packages/fs/` because it is filesystem-backed, even though it is semantically a memory/knowledge consumer. A future seam package can group multiple backends without renaming this one.
- Path containment is enforced by the tool: every requested path is resolved under `vaultRoot`; escapes are rejected. The plugin reads files directly, so it does not inherit `ctx.fs` sandbox policy; this is documented as a known limitation.
- Frontmatter is parsed with `js-yaml`, which is already used elsewhere in the repo.

## Testing

- `packages/fs/tool-memory-filesystem/tests/loader-composition.spec.ts` boots the plugin through the real Cordis Loader and asserts:
  - the three tools are registered with expected schemas,
  - `wiki_read` follows one level of `[[link]]` references,
  - `wiki_search` returns hits by keyword,
  - `wiki_write` appends while preserving frontmatter,
  - paths outside `vaultRoot` are rejected,
  - an unset `vaultRoot` resolves to `<session cwd>/.dsh/memory/` per call.
- `pnpm run typecheck` passes after regenerating `tsconfig.base.json` aliases and adding the package reference to `tsconfig.host.json`.
- Bilingual README and `packages/fs/README.md` group pages were updated; `pnpm run doc-sync` is run to verify the documentation gates.
