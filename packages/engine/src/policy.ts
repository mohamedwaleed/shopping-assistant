/**
 * The models an administrator may choose from. This is a list of names, not a
 * client: the engine never imports an inference SDK, so an installation can
 * describe what it offers without carrying a provider's transport.
 */
export interface ModelOption {
  id: string;
  label: string;
  /** What the model is good for, in the operator's words. */
  description: string;
}

/**
 * What the engine reports about a model's provider without knowing the
 * provider. The engine decides which ids an admin may choose, but how an id is
 * reached is the agent integration boundary's business: these are the route
 * names it uses, repeated here so an admin response can name one without the
 * engine importing an inference SDK.
 */
export type ModelProviderRoute = "openai" | "openai-compatible" | "openrouter";

/** How a model is reached, as far as the engine needs to say so. */
export interface ModelProviderIdentity {
  provider: string;
  model: string;
  route: ModelProviderRoute;
}

/**
 * Everything the application knows how to talk to. The operator's ceiling may
 * narrow this list, never widen it: an id absent here has no adapter behind it.
 */
export const OFFERED_MODELS: readonly ModelOption[] = [
  {
    id: "balanced",
    label: "Balanced",
    description: "Default mix of quality and speed for everyday shopping research.",
  },
  {
    id: "thorough",
    label: "Thorough",
    description: "Slower, more careful reasoning for expensive or intricate purchases.",
  },
  {
    id: "economy",
    label: "Economy",
    description: "Cheapest option, for simple lookups and short conversations.",
  },
];

/**
 * The models the deployment actually allows: the operator's ceiling when there
 * is one, and everything the application offers otherwise.
 */
export function offeredModels(ceiling: string[] | undefined): ModelOption[] {
  if (!ceiling) return [...OFFERED_MODELS];
  return OFFERED_MODELS.filter((model) => ceiling.includes(model.id));
}
