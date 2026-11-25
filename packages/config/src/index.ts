/** A setup token shorter than this cannot be a strong random secret. */
const MINIMUM_SETUP_TOKEN_LENGTH = 32;

/** Better Auth signs session cookies with this secret, so it needs real entropy. */
const MINIMUM_AUTH_SECRET_LENGTH = 32;

const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:54329/shopping_assistant_dev";

const DEFAULT_PUBLIC_BASE_URL = "http://localhost:3000";

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
  /** Secret: signs sessions and verification links, so it must never be exposed. */
  authSecret: string;
  databaseUrl: string;
  /** The origin shoppers reach, used for cookies and verification links. */
  publicBaseUrl: string;
  /** Absent when no SMTP relay is configured; readiness then reports it. */
  email: { smtpUrl: string } | undefined;
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
  const authSecret = environment.BETTER_AUTH_SECRET;
  if (!authSecret) throw new InvalidConfigurationError("BETTER_AUTH_SECRET is required");
  if (authSecret.length < MINIMUM_AUTH_SECRET_LENGTH) {
    throw new InvalidConfigurationError(
      `BETTER_AUTH_SECRET must be at least ${MINIMUM_AUTH_SECRET_LENGTH} characters`,
    );
  }
  const smtpUrl = environment.SMTP_URL;
  return {
    setupToken,
    authSecret,
    databaseUrl: environment.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    publicBaseUrl: environment.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL,
    email: smtpUrl ? { smtpUrl } : undefined,
  };
}
