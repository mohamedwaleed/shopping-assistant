/** A setup token shorter than this cannot be a strong random secret. */
const MINIMUM_SETUP_TOKEN_LENGTH = 32;

const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:54329/shopping_assistant_dev";

/**
 * Names only. A message never repeats a supplied value, because the value may
 * be a credential.
 */
export class InvalidConfigurationError extends Error {
  constructor(problem: string) {
    super(`Invalid installation configuration: ${problem}`);
    this.name = "InvalidConfigurationError";
  }
}

export interface InstallationSettings {
  /** Secret: authorizes creating the first admin, so it must never be exposed. */
  setupToken: string;
  databaseUrl: string;
}

/**
 * Reads operator configuration from the environment. Nothing is cached, so a
 * caller decides when to reload, and the result is never logged wholesale.
 */
export function loadSettings(environment: NodeJS.ProcessEnv = process.env): InstallationSettings {
  const setupToken = environment.SETUP_TOKEN;
  if (!setupToken) throw new InvalidConfigurationError("SETUP_TOKEN is required");
  if (setupToken.length < MINIMUM_SETUP_TOKEN_LENGTH) {
    throw new InvalidConfigurationError(
      `SETUP_TOKEN must be at least ${MINIMUM_SETUP_TOKEN_LENGTH} characters`,
    );
  }
  return {
    setupToken,
    databaseUrl: environment.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  };
}
