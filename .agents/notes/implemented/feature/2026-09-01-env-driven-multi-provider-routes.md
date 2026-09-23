# Agent Note: Environment-driven provider and model selection in dsh-base

Status: implemented

English | [中文](2026-09-01-env-driven-multi-provider-routes.zh.md)

## Problem

`dsh-base` shipped with a single default model route (`deepseek-official` / `deepseek-v4-flash`) and mounted `dsh-llm-pi-ai` dormant. Using another provider required authoring a `cordis.patch.yml` or `llm-pi-ai:` settings section, which is more friction than exporting a well-known API key in `.env`. Users expected the harness to discover available providers from environment variables and to switch the default route without editing committed files.

## Decision

The base bundle now reads launching-environment variables to choose the default provider/model and to auto-register pi-ai routes:

- `DSH_DEFAULT_PROVIDER` / `DSH_DEFAULT_MODEL` override the `agent-default-model` row; defaults keep the existing DeepSeek route.
- `llm-pi-ai` providers are auto-detected from well-known API-key variables: `OPENAI_API_KEY` registers the `openai` route, `ANTHROPIC_API_KEY` registers the `anthropic` route, and `WIZMACAU_API_KEY` or `WIZMACAU_BASE_URL` registers the `wizmacau` hand-declared OpenAI-compatible Ollama route. Optional `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` override each endpoint; `WIZMACAU_BASE_URL` overrides the default `http://192.168.10.28:11434/v1`.
- Only credential references (`apiKeyEnv`) live in the composed configuration; secrets resolve per request through the existing credential seam, so keys can stay in `.env` or the managed credential store.

The detection is implemented as a single `!!js` expression in `packages/bundle/base/cordis.patch.yml`. It returns an empty provider dict when no relevant key is present, leaving the adapter dormant exactly as before. Hand-declared routes and per-route overrides remain available through the `llm-pi-ai:` settings section or a profile patch.

## Alternatives considered

**A typed settings field that lists enabled providers.** Rejected: it duplicates the env-var names and requires editing a file for the common "export a key" workflow.

**Reading `.env` directly inside the adapter.** Rejected: the credential seam already owns precedence (ambient > managed store > `.env` fallback) and key validation; bypassing it would re-implement precedence and leak key-reading logic into the bundle patch.

**One env var per provider with a structured prefix (e.g. `DSH_PI_AI_OPENAI_API_KEY`).** Rejected: it conflicts with provider-native conventions and with users who already have `OPENAI_API_KEY` set for other tooling. Well-known names are the least surprising contract.

## Consequences

- Any base-backed profile (`headless`, `web`, `sdk`, `acp`) gains OpenAI, Anthropic, and Wizmacau Ollama routes automatically when the matching env vars are present; no profile patch is required for the supported providers.
- The default route remains `deepseek-official` / `deepseek-v4-flash` when the env vars are absent, preserving existing behavior.
- Adding a provider beyond the auto-detected set still requires a profile patch or settings entry, because pi-ai hand-declared routes need a protocol and model list.
- The expressions are evaluated once during Loader composition; changing `.env` requires a process restart. Runtime key updates without restart are still available through the managed credential store, which the credential seam watches.

## Testing

- `packages/bundle/base/tests/base.spec.ts` verifies the `DSH_DEFAULT_PROVIDER` / `DSH_DEFAULT_MODEL` fallback and override behavior.
- The same spec verifies the pi-ai provider auto-detection expression for empty env, single-provider, multi-provider-with-base-URL, and Wizmacau Ollama cases.
- `pnpm run doc-sync` passes after updating `packages/bundle/base/README.md`, `README.zh.md`, and their `README.i18n.yaml` pairing record.
