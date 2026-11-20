# Connect models through pinned Vercel AI SDK adapters behind a shared registry

Model access is configuration, not code: one installation default, an optional
per-workspace override, and an optional extraction model, all resolved through a
single registry in `packages/core` (`src/models/model-registry.ts`). The Vercel
AI SDK lives only in the web adapters (`apps/web/lib/models/ai-sdk-probe.ts`
for diagnostics and `apps/web/lib/models/ai-sdk-extraction.ts` for
readable-content extraction), so
core stays framework-free and the worker, MCP and built-in agent tickets can
call the same registry without importing a provider SDK.

## Pinned, verified adapters

| Role | Package | Pin |
| --- | --- | --- |
| SDK core | `ai` | 7.0.172 |
| OpenAI API key | `@ai-sdk/openai` | 4.0.118 (Responses API) |
| Anthropic API key | `@ai-sdk/anthropic` | 4.0.105 |
| Compatible / local | `@ai-sdk/openai-compatible` | 3.0.92 |

The SDK packages are pinned and mirrored in `MODEL_ADAPTER_PINS`, which a test
asserts, so a protocol change cannot arrive unnoticed. `apps/web/test/support/provider-fixtures.ts`
is a loopback server that speaks the exact wire formats these pins emit
(`/v1/responses`, `/v1/messages`, `/v1/chat/completions`), which is how the
capability checks are tested without network access or real keys. Live smoke
checks (`apps/web/test/model-live-smoke.test.ts`) are env-gated, skipped by
default, and never run in CI; they spend at most four calls of 32 output tokens.

Structured output is built on the SDK's own schema validation (`Output.object`
with a JSON schema), so `zod` is not a direct dependency of the adapter and is
not pinned here.

## Capabilities are observed, never assumed

A `compatible` endpoint is not trusted because it answers: the diagnostic runs
four bounded checks through the SDK and records each result.

1. **Text** – a plain `generateText` call that must return text.
2. **Tools** – a typed tool (`capability_probe`, JSON-schema input) must be
   called by the model *and* executed by the SDK.
3. **Structured output** – `generateText` with `output: Output.object({schema})`
   must both send a response format and return an object that validates against
   the schema. The SDK sends it as the provider supports it: `text.format`
   (`json_schema`) on the OpenAI Responses API, `response_format` on the chat
   protocols (`json_schema` where the provider declares support, otherwise
   `json_object`), and a forced `json` tool with the schema on Anthropic. A
   reply that is JSON-shaped prose, or valid JSON of another shape, raises
   `NoObjectGeneratedError` and is recorded `unsupported` without failing the
   rest of the diagnostic.
4. **Streaming** – `streamText` must deliver text and finish, not merely return
   a body.

Capabilities that were not exercised (for example because the call bound was
reached) are recorded as `unsupported`, never assumed. `fixture-model-no-tools`,
`fixture-model-no-structured` (prose), `fixture-model-json-prose` (JSON of the
wrong shape), `fixture-model-no-streaming` and an unauthorized model prove each
negative path.

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

## Field-level precedence

A workspace override applies per field, not per row: it replaces only the
`defaultModel`, `extractionModel` and `usageSource` it actually sets and falls
back to the installation value for the rest. A workspace that configures only
an extraction override therefore keeps serving the installation's default
model instead of appearing unconfigured. The masked view still reports the
workspace row exactly as stored and shows the merged result as `effective`.

## Credential ownership

A stored key belongs to one provider, recorded with the credential. Two guards
enforce it:

- **Saving** a model under a different provider without a new key is refused
  (`invalid-input` on `apiKey`) rather than reusing the old credential.
- **Resolving** a role whose target provider differs from the stored
  credential's provider returns `model-credential-provider-mismatch` instead of
  handing the key over. Configuring an OpenAI default and an Anthropic
  extraction override with only an OpenAI key therefore fails loudly for the
  extraction role rather than sending the OpenAI key to Anthropic.

Switching provider always means supplying a key for it. The adapter repeats the
provider check defensively and reports it as a typed error, never an exception,
so a refused diagnostic surfaces as a configuration error rather than a 500.

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
