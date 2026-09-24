---
description: "Serializes selected tool dispatches through the tools/execute waterfall — opt-in write ordering for memory tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-queue

English | [中文](README.zh.md)

## Summary

`dsh-memory-queue` serializes concurrent dispatches to configured tools — `wiki_write` by default — through the `tools/execute` waterfall. Mounting it gives the memory vault single-writer ordering without modifying `dsh-tool-memory-filesystem`: calls to listed tools acquire a shared FIFO promise chain, while every other tool dispatches unimpeded. With `crossProcessLock` enabled, the serialized section additionally holds an `mkdir`-based lock directory in the vault root so separate dsh processes cannot interleave writes. The plugin registers no tools of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount alongside the memory filesystem plugin:

```yaml
- name: '@deepseek-ai/dsh-tool-memory-filesystem'
- name: '@deepseek-ai/dsh-memory-queue'
```

### Configure the queue

| Field | Type | Default | Description |
|---|---|---|---|
| `toolNames` | `string[]` | `['wiki_write']` | Tool names whose dispatches serialize through one shared chain. |
| `vaultRoot` | `string` | `''` → `<session cwd>/.dsh/memory/` | Vault root hosting the lock directory; same per-call resolution as the memory tools. |
| `crossProcessLock` | `boolean` | `false` | Acquire a lock directory in the vault root around each serialized dispatch so separate processes cannot interleave calls. |
| `lockStaleMs` | `number` | `60000` | A lock untouched this long counts as abandoned and is reclaimed. |
| `lockTimeoutMs` | `number` | `30000` | Give up waiting for a held lock after this many milliseconds. |
| `lockRetryMs` | `number` | `100` | Delay between lock acquisition attempts. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin installs one `ctx.on('tools/execute', …)` waterfall listener. Dispatches whose tool name is in `toolNames` are appended to a single promise chain; each call runs `next()` only after the previous serialized call settles, so failure of one call cannot stall later ones. Unlisted tools pass straight through to `next()`. With `crossProcessLock`, the serialized section wraps `next()` in an `mkdir` lock at `<vault>/.memory-queue.lock`: `mkdir` is atomic on POSIX filesystems, so exactly one process holds the lock; a directory whose mtime is older than `lockStaleMs` is treated as abandoned and reclaimed; a caller waiting past `lockTimeoutMs` fails the dispatch loudly.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin registers no tools, prompts, or results of its own — it only reorders dispatches to tools other packages own.

#### KV Cache effect

The wrapper does not change the request header, system prompt, or tool list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Lock is advisory** — `crossProcessLock` only guards processes that mount this plugin; a writer outside the waterfall (another tool, a shell command) can still race the vault.
- **One chain for all listed tools** — calls to different configured tools serialize against each other; per-tool or per-note lanes are deferred.
- **Stale-lock tradeoff** — `lockStaleMs` must exceed the slowest legitimate dispatch or a live holder's lock can be reclaimed mid-write.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
