import { describe, expect, it } from "vitest";
import { InvalidConfigurationError, loadSettings } from "./index.ts";

const SETUP_TOKEN = "setup-token-0f9c1c1e4b6d4a51a2c3f0e5d7b8a9c6";

describe("installation settings", () => {
  it("takes the setup token and database URL from the environment", () => {
    const settings = loadSettings({ SETUP_TOKEN, DATABASE_URL: "postgres://db/shopping" });

    expect(settings.setupToken).toBe(SETUP_TOKEN);
    expect(settings.databaseUrl).toBe("postgres://db/shopping");
  });

  it("refuses to start without a setup token", () => {
    expect(() => loadSettings({})).toThrow(InvalidConfigurationError);
  });

  it("refuses a setup token too short to be strong", () => {
    expect(() => loadSettings({ SETUP_TOKEN: "short-token" })).toThrow(InvalidConfigurationError);
  });

  it("keeps the setup token out of its own error messages", () => {
    const weak = "weak";
    const failure = (() => {
      try {
        loadSettings({ SETUP_TOKEN: weak });
        return undefined;
      } catch (error) {
        return error as Error;
      }
    })();

    expect(failure).toBeInstanceOf(InvalidConfigurationError);
    expect(failure?.message).not.toContain(weak);
  });
});
