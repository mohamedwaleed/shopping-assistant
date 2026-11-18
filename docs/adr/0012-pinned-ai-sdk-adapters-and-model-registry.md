# Connect models through pinned Vercel AI SDK adapters behind a shared registry

Model access is configuration, not code: one installation default, an optional
per-workspace override, and an optional extraction model, all resolved through a
single registry in `packages/core` (`src/models/model-registry.ts`). The Vercel
AI SDK lives only in the web adapter (`apps/web/lib/models/ai-sdk-probe.ts`), so
core stays framework-free and the worker, MCP and built-in agent tickets can
call the same registry without importing a provider SDK.

## Pinned, verified adapters

| Role | Package | Pin |
| --- | --- | --- |
| SDK core | `ai` | 7.0.172 |
| OpenAI API key | `@ai-sdk/openai` | 4.0.118 (Responses API) |
| Anthropic API key | `@ai-sdk/anthropic` | 4.0.105 |
| Compatible / local | `@ai-sdk/openai-compatible` | 3.0.92 |
| Structured JSON validation | `zod` | 4.6.7 |

Versions are pinned and mirrored in `MODEL_ADAPTER_PINS`, which a test asserts,
so a protocol change cannot arrive unnoticed. `apps/web/test/support/provider-fixtures.ts`
is a loopback server that speaks the exact wire formats these pins emit
(`/v1/responses`, `/v1/messages`, `/v1/chat/completions`), which is how the
capability checks are tested without network access or real keys. Live smoke
checks (`apps/web/test/model-live-smoke.test.ts`) are env-gated, skipped by
default, and never run in CI; they spend at most four calls of 32 output tokens.

## Capabilities are observed, never assumed

A `compatible` endpoint is not trusted because it answers: the diagnostic runs
four bounded checks through the SDK and records each result.

1. **Text** – a plain `generateText` call that must return text.
2. **Tools** – a typed tool (`capability_probe`, JSON-schema input) must be
   called by the model *and* executed by the SDK.
3. **Structured output** – the reply must parse as the expected JSON object;
   prose from an endpoint that ignores the schema fails validation.
4. **Streaming** – `streamText` must deliver text and finish, not merely return
   a body.

Capabilities that were not exercised (for example because the call bound was
reached) are recorded as `unsupported`, never assumed. `fixture-model-no-tools`,
`fixture-model-no-structured`, `fixture-model-no-streaming` and an unauthorized
model prove each negative path.

## Bounds are code

`DEFAULT_DIAGNOSTIC_BOUNDS` is four model calls of 64 output tokens; the hard
ceilings are eight calls and 512 output tokens. `diagnosticBounds()` rejects
anything outside them as `invalid-input` before a provider is contacted, and the
adapter charges one unit per call, sets `maxOutputTokens` to the bound, and
disables SDK retries (`maxRetries: 0`) so a failing endpoint cannot multiply the
spend. The tool check runs with `stepCountIs(1)`: the tool executes, but no
follow-up generation is made, keeping the call count exact.

## No hidden fallback

`resolve()` returns a typed `model-not-configured` or `model-credential-missing`
error rather than another provider, model or account. `usageSource` is stored
with the configuration, so a workspace that overrides the model but keeps the
installation account is explicit; a workspace key is never used unless that
workspace selected it, and the installation key is never borrowed implicitly.
Changing the model clears any earlier capability report, so a stale success is
never shown for a new endpoint.

## Credential ownership

A stored key belongs to one provider. Saving a model under a different provider
without a new key is refused (`invalid-input` on `apiKey`) rather than reusing
the old credential, and the adapter rejects a probe whose credential provider
does not match the configured model. Switching provider therefore always means
supplying a key for it, never sending an existing key somewhere it was not
issued for.

## Secrets

Provider keys are encrypted with AES-256-GCM under `INSTALLATION_SECRET`, which
is held outside PostgreSQL; a database dump alone reveals nothing. Only a masked
hint (`sk-…001`) is ever returned to the browser or stored in a report, and the
HTTP contract tests assert that keys appear in neither responses nor captured
console output. Keys travel only as provider headers to the configured endpoint.
A missing or short `INSTALLATION_SECRET` fails the request that needs it instead
of falling back to a development key.

## Authorization

Installation defaults are `installation.manage` (administrator only); workspace
overrides require admitted membership and are resolved from
`workspace_memberships`, so a request naming another workspace gains nothing.
Reading settings is available to any admitted member because the page has to
explain which model serves their workspace, and every read is a masked view.
