---
description: "通过 tools/execute waterfall 串行化指定工具调用——为记忆工具提供可选的写顺序保障。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-queue

[English](README.md) | 中文

## 概述

`dsh-memory-queue` 通过 `tools/execute` waterfall 把发往指定工具（默认 `wiki_write`）的并发调用串行化。挂载后记忆仓库获得单写者顺序保证，且**不需要修改** `dsh-tool-memory-filesystem`：被列出的工具调用进入共享 FIFO 链，其余工具调用照常派发。本插件不注册任何工具。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用

与记忆 filesystem 插件一起挂载：

```yaml
- name: '@deepseek-ai/dsh-tool-memory-filesystem'
- name: '@deepseek-ai/dsh-memory-queue'
```

### 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `tools` | `string[]` | `['wiki_write']` | 需要进入同一条串行链的工具名列表。 |

-----

<a id="understand-the-implementation"></a>
## 实现说明

插件安装一个 `ctx.on('tools/execute', …)` waterfall 监听器。工具名在 `tools` 中的调用被追加到一条共享 promise 链；每个调用都在前一个串行调用结束后才执行 `next()`，因此单个调用失败不会卡住后续调用。未列出的工具直接 `next()` 透传。

-----

<a id="model-experience"></a>
## 模型体验

无 —— 插件不注册任何工具、prompt 或结果，只对其他包的工具调用重排序。

#### KV Cache 影响

该包装层不改变请求头、system prompt 或工具列表。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **仅单进程** —— 串行链只约束同一 Cordis 上下文内的调用；不同 OS 进程仍可能对同一仓库产生竞态。
- **所有列出工具共用一条链** —— 不同配置工具之间也互相串行；按工具或按笔记分通道的能力留待后续。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
