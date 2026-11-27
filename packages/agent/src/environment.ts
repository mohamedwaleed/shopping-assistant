import {
  ModelConfigurationError,
  type ConfiguredModel,
  type ModelConfiguration,
  type ProviderConfiguration,
  type ProviderRoute,
} from "./providers.ts";

const ROUTES: readonly ProviderRoute[] = ["openai", "openai-compatible", "openrouter"];

/** The variables that configure providers rather than list models. */
const NON_MODEL_VARIABLES = new Set([
  "MODEL_OPENAI_API_KEY",
  "MODEL_OPENAI_BASE_URL",
  "MODEL_COMPATIBLE_BASE_URL",
  "MODEL_COMPATIBLE_API_KEY",
  "MODEL_OPENROUTER_API_KEY",
  "MODEL_OPENROUTER_BASE_URL",
  "MODEL_SITE_URL",
  "MODEL_APP_NAME",
  // The live check's own switch, which lives with the configuration it gates.
  "MODEL_LIVE_CHECK",
]);

function isRoute(value: string): value is ProviderRoute {
  return (ROUTES as readonly string[]).includes(value);
}

/**
 * The providers an operator can configure, one variable each. They are read
 * separately rather than from one JSON blob so that a credential lives in the
 * same place as the rest of the deployment's secrets, and so a typo in one
 * provider does not silently discard the others.
 *
 *   MODEL_OPENAI_API_KEY         the credential for the direct OpenAI route
 *   MODEL_OPENAI_BASE_URL        optional; a proxy or a regional endpoint
 *   MODEL_COMPATIBLE_BASE_URL    an OpenAI-compatible server, required for it
 *   MODEL_COMPATIBLE_API_KEY     optional; a self-hosted server may need none
 *   MODEL_OPENROUTER_API_KEY     the credential for OpenRouter
 *   MODEL_OPENROUTER_BASE_URL    optional; a proxy in front of OpenRouter
 *   MODEL_SITE_URL, MODEL_APP_NAME  what OpenRouter attributes traffic to
 *
 * Models are then listed as `MODEL_<ID>=<provider>:<model>`, one per offered
 * id, e.g. `MODEL_BALANCED=openai:gpt-5-mini`. The offered ids are the engine's
 * (`balanced`, `thorough`, `economy`), so an admin chooses an id and the
 * operator decides which real model stands behind it.
 */
export function modelConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ModelConfiguration {
  const providers: ProviderConfiguration[] = [];

  const openaiKey = environment.MODEL_OPENAI_API_KEY;
  if (openaiKey) {
    providers.push({
      id: "openai",
      route: "openai",
      apiKey: openaiKey,
      ...(environment.MODEL_OPENAI_BASE_URL ? { baseUrl: environment.MODEL_OPENAI_BASE_URL } : {}),
    });
  }

  const compatibleBaseUrl = environment.MODEL_COMPATIBLE_BASE_URL;
  if (compatibleBaseUrl) {
    providers.push({
      id: "compatible",
      route: "openai-compatible",
      baseUrl: compatibleBaseUrl,
      ...(environment.MODEL_COMPATIBLE_API_KEY
        ? { apiKey: environment.MODEL_COMPATIBLE_API_KEY }
        : {}),
    });
  }

  const openRouterKey = environment.MODEL_OPENROUTER_API_KEY;
  if (openRouterKey) {
    const siteUrl = environment.MODEL_SITE_URL;
    const appName = environment.MODEL_APP_NAME;
    providers.push({
      id: "openrouter",
      route: "openrouter",
      apiKey: openRouterKey,
      ...(environment.MODEL_OPENROUTER_BASE_URL
        ? { baseUrl: environment.MODEL_OPENROUTER_BASE_URL }
        : {}),
      ...(siteUrl || appName
        ? { attribution: { ...(siteUrl ? { siteUrl } : {}), ...(appName ? { appName } : {}) } }
        : {}),
    });
  }

  const models: ConfiguredModel[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith("MODEL_") || !value) continue;
    // The credentials, endpoints, and attribution share the prefix. Only the
    // remaining `MODEL_<id>=<route>:<model>` variables are model listings, and
    // they are listed explicitly so a URL's own colon cannot be mistaken for one.
    if (NON_MODEL_VARIABLES.has(name)) continue;
    const id = name.slice("MODEL_".length).toLowerCase();
    const separator = value.indexOf(":");
    if (separator < 0) continue;
    const providerId = value.slice(0, separator);
    const model = value.slice(separator + 1);
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new ModelConfigurationError(`${name} names an unconfigured provider`);
    }
    if (!model) throw new ModelConfigurationError(`${name} names no model`);
    models.push({ id, model, provider: providerId });
  }

  return { providers, models };
}

/**
 * The configuration, refusing one that cannot be used. A model with no provider
 * behind it would surface as a failure mid-conversation, so it is refused where
 * an operator can see it instead.
 */
export function loadModelConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): ModelConfiguration {
  const configuration = modelConfigurationFromEnvironment(environment);
  const ids = new Set<string>();
  for (const model of configuration.models) {
    if (ids.has(model.id)) throw new ModelConfigurationError(`model ${model.id} is listed twice`);
    ids.add(model.id);
    if (!isRoute(configuration.providers.find((p) => p.id === model.provider)?.route ?? "openai")) {
      throw new ModelConfigurationError(`model ${model.id} names an unknown route`);
    }
  }
  return configuration;
}
