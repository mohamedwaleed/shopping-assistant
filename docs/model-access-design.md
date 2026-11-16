# Model access: keys and subscriptions

Status: requested capability, partly feasible subject to provider integration/eligibility verification. Verified against official documentation on 2026-11-17. No implementation or entitlement approval is claimed.

## User intent

Configure supported API keys or connect an existing ChatGPT/Claude subscription for AI inference. Keep this provider connection separate from Better Auth application sign-in and private workspace ownership. App access remains invitation controlled; authorizing an AI connection must not create or merge app users implicitly.

## Official findings

- OpenAI publishes an OSS plan-usage integration, with identity and plan usage as separate permissions: https://developers.openai.com/siwc/token-sharing-open-source .
- The open-source cookbook describes local-app access and instructs paid/remotely hosted apps to request access; it also points to separate DevKit licensing that must be reviewed before reuse: https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt . Do not assume reference implementation licensing is equivalent to the project's AGPL choice.
- An official private self-hosted-VM guide exists; local callback/credential transfer has specific handling and current limitations: https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms . Do not conflate private self-hosting with approval for a paid multi-user hosted service.
- Account-specific model discovery and authorized inference use the documented public Responses API route: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference .
- Preview limitations include streaming/store requirements, unsupported parameters, history handling and restricted tool formats: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations . An AI SDK adapter must prove conformance; default API-key-provider requests are not assumed compatible.
- Claude's developer SDK documentation says offering claude.ai login/rate limits for third-party products requires prior approval, otherwise use API keys: https://code.claude.com/docs/en/agent-sdk/overview .
- Claude's account guidance directs developers building products for others to API-key auth and describes third-party usage-credit conditions: https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account .
- A separate support article states Agent SDK/CLI subscription usage still draws from plan limits: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan . This creates ambiguity for product integration; retain both references and do not interpret personal SDK use as blanket authorization for our product.

## Design constraints

- API-key, compatible/local inference, and officially permitted subscription modes have distinct authentication and capability configuration.
- Provider OAuth is a workspace-owned connection with consent, expiry/refresh and disconnect; keep tokens out of browser/model payloads.
- Separate application identity from provider identity and model access. Do not link by matching email alone or bypass invitations.
- Show models available to the actual connection. Verify typed tools/structured output/streaming and app-enforced budgets for each adapter.
- Subscription depletion/revocation pauses affected work; paid-key fallback needs explicit configuration. Background use needs explicit consent and provider permission.
- Embeddings remain separately configured and optional; do not claim that a chat subscription covers an embedding endpoint.
- Future paid hosting must obtain applicable access rather than inheriting self-hosted eligibility. A Claude plan connection remains a requested but provider-gated feature until a supported/approved route is demonstrated.

## pgvector clarification

pgvector stores/searches embedding vectors in PostgreSQL; the embedding model determines semantic representation. It can help retrieve descriptively similar or cross-language candidates, but cannot validate must-haves or exact identity. It is already optional: full-text, trigram, identifier and structured retrieval work without it. Additional storage, embedding generation/reindexing and relevance evaluation are costs of enabling it. Measure benefit on the agreed bilingual catalogue benchmark before enabling it by default; this is a recommendation, not a user-approved removal of semantic-search support.

Reference: https://github.com/pgvector/pgvector#hybrid-search . No database extension or model package was installed.
