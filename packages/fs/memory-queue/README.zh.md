---
description: "通过 tools/execute waterfall 串行化指定工具调用——为记忆工具提供可选的写顺序保障。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-queue

[English](README.md) | 中文

## 概述

`dsh-memory-queue` 通过 `tools/execute` waterfall 把发往指定工具（默认 `wiki_write`）的并发调用串行化。挂载后记忆仓库获得单写者顺序保证，且**不需要修改** `dsh-tool-memory-filesystem`：被列出的工具调用进入共享 FIFO 链，其余工具调用照常派发。开启 `crossProcessLock` 后，串行区段还会在仓库根目录持有一个基于 `mkdir` 的锁目录，使不同的 dsh 进程也无法交错写入。本插件不注册任何工具。

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
| `toolNames` | `string[]` | `['wiki_write']` | 需要进入同一条串行链的工具名列表。 |
| `vaultRoot` | `string` | `''` → `<session cwd>/.dsh/memory/` | 锁目录所在的仓库根；与记忆工具相同的按调用解析规则。 |
| `crossProcessLock` | `boolean` | `false` | 在每次串行派发前后于仓库根获取锁目录，使不同进程无法交错调用。 |
| `lockStaleMs` | `number` | `15000` | 锁目录超过该时长未刷新即视为被遗弃并被回收；必须大于 `2 × lockHeartbeatMs`。 |
| `lockHeartbeatMs` | `number` | `2000` | 持有方刷新锁目录 mtime 的间隔。 |
| `lockTimeoutMs` | `number` | `30000` | 等待持有方释放锁的超时毫秒数。 |
| `lockRetryMs` | `number` | `100` | 锁获取重试间隔。 |

-----

<a id="understand-the-implementation"></a>
## 实现说明

插件安装一个 `ctx.on('tools/execute', …)` waterfall 监听器。工具名在 `toolNames` 中的调用被追加到一条共享 promise 链；每个调用都在前一个串行调用结束后才执行 `next()`，因此单个调用失败不会卡住后续调用。未列出的工具直接 `next()` 透传。开启 `crossProcessLock` 时，串行区段用 `<vault>/.memory-queue.lock` 上的 `mkdir` 包裹 `next()`：`mkdir` 在 POSIX 文件系统上是原子操作，同一时刻只有一个进程持有锁。持有方写入一份诊断用的 `owner.json`，并每 `lockHeartbeatMs` 刷新一次目录 mtime——判活基于心跳：锁只在持有方死亡时过期，绝不因写入耗时长而被误回收；等待超过 `lockTimeoutMs` 的调用直接失败。

-----

<a id="model-experience"></a>
## 模型体验

无 —— 插件不注册任何工具、prompt 或结果，只对其他包的工具调用重排序。

#### KV Cache 影响

该包装层不改变请求头、system prompt 或工具列表。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **锁是咨询性的** —— `crossProcessLock` 只约束挂载了本插件的进程；瀑布链之外的写入方（其他工具、shell 命令）仍可能与仓库竞态。
- **所有列出工具共用一条链** —— 不同配置工具之间也互相串行；按工具或按笔记分通道的能力留待后续。
- **NFS 时钟偏差** —— 心跳判活依赖目录 mtime；mtime 一致性弱的文件系统上，死亡持有方的锁可能残留最多 `lockStaleMs`，严重时钟偏差也可能让活锁显得过期。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
