import { describe, expect, it } from "vitest";
import { InvalidConfigurationError, loadSettings } from "./index.ts";

const SETUP_TOKEN = "setup-token-0f9c1c1e4b6d4a51a2c3f0e5d7b8a9c6";
const AUTH_SECRET = "auth-secret-7d1f2b3c4e5a69788796a5b4c3d2e1f0";

describe("installation settings", () => {
  it("takes the setup token and database URL from the environment", () => {
    const settings = loadSettings({
      SETUP_TOKEN,
      BETTER_AUTH_SECRET: AUTH_SECRET,
      DATABASE_URL: "postgres://db/shopping",
    });

    expect(settings.setupToken).toBe(SETUP_TOKEN);
    expect(settings.databaseUrl).toBe("postgres://db/shopping");
  });

  it("refuses to start without a setup token", () => {
    expect(() => loadSettings({ BETTER_AUTH_SECRET: AUTH_SECRET })).toThrow(
      InvalidConfigurationError,
    );
  });

  it("refuses a setup token too short to be strong", () => {
    expect(() => loadSettings({ SETUP_TOKEN: "short-token", BETTER_AUTH_SECRET: AUTH_SECRET })).toThrow(
      InvalidConfigurationError,
    );
  });

  it("refuses to start without an auth secret", () => {
    expect(() => loadSettings({ SETUP_TOKEN })).toThrow(InvalidConfigurationError);
  });

  it("refuses an auth secret too short to sign sessions", () => {
    expect(() => loadSettings({ SETUP_TOKEN, BETTER_AUTH_SECRET: "short" })).toThrow(
      InvalidConfigurationError,
    );
  });

  it("reports no email service when SMTP is not configured", () => {
    const settings = loadSettings({ SETUP_TOKEN, BETTER_AUTH_SECRET: AUTH_SECRET });

    expect(settings.email).toBeUndefined();
  });

  it("carries the SMTP relay and the public base URL when configured", () => {
    const settings = loadSettings({
      SETUP_TOKEN,
      BETTER_AUTH_SECRET: AUTH_SECRET,
      SMTP_URL: "smtp://relay.example:587",
      PUBLIC_BASE_URL: "https://shopping.example",
    });

    expect(settings.email).toEqual({ smtpUrl: "smtp://relay.example:587" });
    expect(settings.publicBaseUrl).toBe("https://shopping.example");
  });

  it("defaults the public base URL to the local installation", () => {
    const settings = loadSettings({ SETUP_TOKEN, BETTER_AUTH_SECRET: AUTH_SECRET });

    expect(settings.publicBaseUrl).toBe("http://localhost:3000");
  });

  it("keeps secrets out of its own error messages", () => {
    const weak = "weak";
    const failure = (() => {
      try {
        loadSettings({ SETUP_TOKEN: weak, BETTER_AUTH_SECRET: weak });
        return undefined;
      } catch (error) {
        return error as Error;
      }
    })();

    expect(failure).toBeInstanceOf(InvalidConfigurationError);
    expect(failure?.message).not.toContain(weak);
  });

  it("carries the price of a page retrieval when the operator sets one", () => {
    const settings = loadSettings({
      SETUP_TOKEN,
      BETTER_AUTH_SECRET: AUTH_SECRET,
      RETRIEVAL_COST_CENTS: "2",
    });

    expect(settings.retrievalCostCents).toBe(2);
  });

  it("reports no retrieval price when the operator has not set one", () => {
    // An unpriced retrieval is not a free one: the ledger records the cost as
    // unknown, so an absent setting must stay absent rather than become zero.
    const settings = loadSettings({ SETUP_TOKEN, BETTER_AUTH_SECRET: AUTH_SECRET });

    expect(settings.retrievalCostCents).toBeUndefined();
  });

  it("refuses a retrieval price that is not a whole number of cents", () => {
    for (const value of ["-1", "1.5", "one", ""]) {
      expect(
        () =>
          loadSettings({
            SETUP_TOKEN,
            BETTER_AUTH_SECRET: AUTH_SECRET,
            RETRIEVAL_COST_CENTS: value,
          }),
        value,
      ).toThrow(InvalidConfigurationError);
    }
  });

  it("names the setting it rejected without repeating its value", () => {
    const failure = (() => {
      try {
        loadSettings({ SETUP_TOKEN, BETTER_AUTH_SECRET: AUTH_SECRET, RETRIEVAL_COST_CENTS: "1.5" });
        return undefined;
      } catch (error) {
        return error as Error;
      }
    })();

    expect(failure?.message).toContain("RETRIEVAL_COST_CENTS");
    expect(failure?.message).not.toContain("1.5");
  });
});
