---
description: "Serializes selected tool dispatches through the tools/execute waterfall — opt-in write ordering for memory tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-queue

English | [中文](README.zh.md)

## Summary

`dsh-memory-queue` serializes concurrent dispatches to configured tools — `wiki_write` by default — through the `tools/execute` waterfall. Mounting it gives the memory vault single-writer ordering without modifying `dsh-tool-memory-filesystem`: calls to listed tools acquire a shared FIFO promise chain, while every other tool dispatches unimpeded. The plugin registers no tools of its own.

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
| `tools` | `string[]` | `['wiki_write']` | Tool names whose dispatches serialize through one shared chain. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin installs one `ctx.on('tools/execute', …)` waterfall listener. Dispatches whose tool name is in `tools` are appended to a single promise chain; each call runs `next()` only after the previous serialized call settles, so failure of one call cannot stall later ones. Unlisted tools pass straight through to `next()`.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin registers no tools, prompts, or results of its own — it only reorders dispatches to tools other packages own.

#### KV Cache effect

The wrapper does not change the request header, system prompt, or tool list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Single process** — the chain orders calls within one Cordis context; separate OS processes can still race on the same vault.
- **One chain for all listed tools** — calls to different configured tools serialize against each other; per-tool or per-note lanes are deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
