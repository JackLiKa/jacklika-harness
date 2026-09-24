# Agent Note：可选的文件系统 wiki/记忆工具

Status: implemented

[English](2026-09-04-opt-in-filesystem-memory-tool.md) | 中文

## 问题

dsh 已有丰富的事件溯源会话记忆，但缺少用户可长期拥有的知识存储。一些用户把项目知识放在 Obsidian 风格的 Markdown 仓库中，希望 agent 能读取、搜索和追加笔记，而无需替换核心会话架构。这一改动必须遵循开闭原则：以扩展方式新增存储选项，而非修改现有记忆核心。

## 决策

新增 `@deepseek-ai/dsh-tool-memory-filesystem`，一个位于 `packages/fs/tool-memory-filesystem/` 的 Cordis 插件，注册三个面向模型的工具：

- `wiki_read(id)` — 读取 Markdown 笔记，解析 YAML frontmatter，并按配置深度跟随 Obsidian 风格 `[[link]]` 链接。
- `wiki_search(query)` — 按标题、id 和正文关键词搜索；结果包含反向链接数量。
- `wiki_write(id, content, mode?)` — 创建或追加笔记。追加模式保留 frontmatter 并添加时间戳标题。

该插件是可选启用的：通过 profile patch 挂载，`vaultRoot` 可选：

```yaml
- name: '@deepseek-ai/dsh-tool-memory-filesystem'
```

未设置 `vaultRoot` 时，每次工具调用把仓库解析到 `<session cwd>/.dsh/memory/`，使每个项目工作区拥有独立的记忆库；显式 `vaultRoot` 则固定一个共享仓库，相对路径锚定会话工作区。未挂载该插件时，默认会话记忆行为保持不变。

## 替代方案

**修改 `dsh-session-persistence-jsonl` 或 `dsh-tool-fs` 以理解 Markdown/Obsidian。** 拒绝：这会把会话持久化或通用文件工具与某一种知识表示耦合，且不利于后续切换不同后端。

**在首个 PR 就引入完整的 `ctx.memory` 能力 seams 与多 provider。** 拒绝：用户明确要求 MVP。能力 seams 是长期正确方向，但先做一个具体工具包能控制改动范围，并在抽象前验证用户可见的契约。

**在 MVP 中实现向量/RAG 搜索。** 拒绝：用户指出向量检索在很多场景有天然缺陷，希望先用简单的关键词/链接方案。独立的 `tool-memory-vector` 包现已提供可选的 embedding 检索，无需修改本包。

## 伴随包

三个可选包在不修改本插件的前提下扩展仓库能力：

- `@deepseek-ai/dsh-tool-memory-graph` —— `wiki_graph` 返回仓库的 `[[link]]` 节点/边图或以某笔记为中心的子图，复用本包的解析辅助函数。
- `@deepseek-ai/dsh-memory-queue` —— 通过 `tools/execute` waterfall 把 `wiki_write`（可配置）调用串行化，提供单写者顺序；可选的 `crossProcessLock` 在仓库根持有 `mkdir` 锁目录，使不同 dsh 进程也无法交错写入。
- `@deepseek-ai/dsh-tool-memory-vector` —— `wiki_semantic_search` 通过可配置的 OpenAI 兼容端点取 embedding，按余弦相似度排序，向量按 mtime 缓存在仓库内 `.vector-index.json`。

`indexHiddenDirs` 配置项（默认 `false`）让 `vaultRoot` 指向工作区根的部署也能索引 `.dsh/memory/` 中的笔记，同时 `.git`/`node_modules` 始终排除。

## 后果

- 现有会话事件日志和 JSONL 持久化均未改动。
- 用户可把任意 profile 指向一个 Markdown 仓库，立即获得 `wiki_read`/`wiki_search`/`wiki_write`。
- 包放在 `packages/fs/` 下，因为它以文件系统为后端；尽管语义上是记忆/知识消费者，未来可以新增 seams 包来组合多个后端，而无需重命名本包。
- 工具内强制路径约束：所有请求路径都解析在 `vaultRoot` 下；越界路径会被拒绝。插件直接读取文件，因此不继承 `ctx.fs` 沙箱策略；这一点在文档中作为已知限制说明。
- frontmatter 使用仓库中已有的 `js-yaml` 解析。

## 测试

- `packages/fs/tool-memory-filesystem/tests/loader-composition.spec.ts` 通过真实 Cordis Loader 启动插件，并验证：
  - 三个工具按预期 schema 注册，
  - `wiki_read` 能跟随一层 `[[link]]` 链接，
  - `wiki_search` 按关键词返回结果，
  - `wiki_write` 追加内容同时保留 frontmatter，
  - 越出 `vaultRoot` 的路径被拒绝，
  - 未设置 `vaultRoot` 时按调用解析到 `<session cwd>/.dsh/memory/`。
- 重新生成 `tsconfig.base.json` 别名并在 `tsconfig.host.json` 中添加包引用后，`pnpm run typecheck` 通过。
- 更新了中英双语 README 与 `packages/fs/README.md` 分组页，并运行 `pnpm run doc-sync` 检查文档门控。
