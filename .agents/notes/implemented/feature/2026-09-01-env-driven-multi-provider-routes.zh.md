# Agent Note: dsh-base 中基于环境变量的提供方与模型选择

Status: implemented

[English](2026-09-01-env-driven-multi-provider-routes.md) | 中文

## 问题

`dsh-base` 出厂时只带有一个默认模型路由（`deepseek-official` / `deepseek-v4-flash`），并且 `dsh-llm-pi-ai` 以休眠方式挂载。要使用其他提供方，必须编写 `cordis.patch.yml` 或 `llm-pi-ai:` settings 区，这比在 `.env` 里导出常见 API key 更繁琐。用户期望 harness 能够从环境变量中发现可用的提供方，并在不修改已提交文件的情况下切换默认路由。

## 决策

基础组合包现在读取启动时的环境变量来选择默认提供方/模型，并自动注册 pi-ai 路由：

- `DSH_DEFAULT_PROVIDER` / `DSH_DEFAULT_MODEL` 覆盖 `agent-default-model` 行；未设置时保留原有 DeepSeek 路由。
- `llm-pi-ai` 的提供方从知名 API-key 环境变量自动探测：`OPENAI_API_KEY` 注册 `openai` 路由，`ANTHROPIC_API_KEY` 注册 `anthropic` 路由，`WIZMACAU_API_KEY` 或 `WIZMACAU_BASE_URL` 注册手写的 OpenAI-compatible Ollama `wizmacau` 路由。可选的 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` 覆盖对应端点；`WIZMACAU_BASE_URL` 覆盖默认的 `http://192.168.10.28:11434/v1`。
- 组合配置中只保存凭证引用（`apiKeyEnv`）；实际 key 在每次请求时通过现有凭证 seam 解析，因此可以留在 `.env` 或受管凭证存储中。

探测逻辑以单个 `!!js` 表达式实现于 `packages/bundle/base/cordis.patch.yml`。当没有相关 key 时返回空提供方字典，保持适配器与之前一样休眠。自定义路由和各路由覆盖仍可通过 `llm-pi-ai:` settings 区或 profile patch 提供。

## 放弃的替代方案

**在 settings 中列出启用提供方的字段。** 已放弃：它会重复环境变量名，并要求为常见的“导出一个 key”流程编辑文件。

**在适配器内直接读取 `.env`。** 已放弃：凭证 seam 已经拥有优先级（环境变量 > 受管存储 > `.env` 回退）和 key 校验；绕过它会导致 bundle patch 重新实现优先级并泄漏 key 读取逻辑。

**为每个提供方使用结构化前缀的环境变量（如 `DSH_PI_AI_OPENAI_API_KEY`）。** 已放弃：这与提供方原生约定冲突，也会破坏已经设置了 `OPENAI_API_KEY` 供其他工具使用的用户。使用知名变量名是最不令人意外的约定。

## 后果

- 任何基于 base 的 profile（`headless`、`web`、`sdk`、`acp`）在有匹配环境变量时自动获得 OpenAI、Anthropic 和 Wizmacau Ollama 路由；支持这些提供方不需要 profile patch。
- 当环境变量缺失时，默认路由仍保持为 `deepseek-official` / `deepseek-v4-flash`，不破坏现有行为。
- 超出自动探测集合的提供方仍需要 profile patch 或 settings 条目，因为 pi-ai 的自定义路由需要指定协议和模型列表。
- 表达式在 Loader 组合时求值一次；修改 `.env` 需要重启进程。若要不重启更新 key，仍可通过受管凭证存储，由凭证 seam 监听其变更。

## 测试

- `packages/bundle/base/tests/base.spec.ts` 验证 `DSH_DEFAULT_PROVIDER` / `DSH_DEFAULT_MODEL` 的默认与覆盖行为。
- 同一份测试验证 pi-ai 提供方自动探测表达式：空环境、单一提供方、多提供方带 base URL，以及 Wizmacau Ollama 四种情况。
- 更新 `packages/bundle/base/README.md`、`README.zh.md` 及其 `README.i18n.yaml` 配对记录后，`pnpm run doc-sync` 通过。
