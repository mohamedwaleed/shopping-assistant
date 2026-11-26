import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createAccount, createTestSchema, migrate } from "@shopping-assistant/database/testing";
import {
  createEngine,
  NotAnAdminError,
  PolicyRefusedError,
  type Engine,
  type ModelProviderIdentity,
} from "@shopping-assistant/engine";
import { createFakeIdentityStore } from "@shopping-assistant/engine/testing";
import {
  createModelProviders,
  DiagnosticAllowanceExhaustedError,
  ModelNotConfiguredError,
  type DiagnosticAllowance,
  type ModelProviders,
} from "./model-providers.ts";
import type { ModelConfiguration } from "./providers.ts";
import {
  fixtureTransport,
  notStreaming,
  wellBehaved,
  type ProviderBehaviour,
} from "./fixtures/transport.ts";

let server: Database;

const API_KEY = "sk-fixture-2c8f1d9a4e7b";

/** What the operator wired each offered id to. */
const PROVIDERS: Record<string, ModelProviderIdentity> = {
  balanced: { provider: "openai", model: "gpt-4o-mini", route: "openai" },
  thorough: { provider: "compatible", model: "local-large", route: "openai-compatible" },
  economy: { provider: "openrouter", model: "openai/gpt-4o-mini", route: "openrouter" },
};

const configuration: ModelConfiguration = {
  providers: [
    { id: "openai", route: "openai", apiKey: API_KEY },
    {
      id: "compatible",
      route: "openai-compatible",
      apiKey: API_KEY,
      baseUrl: "https://llm.example.com/v1",
    },
    { id: "openrouter", route: "openrouter", apiKey: API_KEY },
  ],
  models: [
    { id: "balanced", provider: "openai", model: "gpt-4o-mini" },
    { id: "thorough", provider: "compatible", model: "local-large" },
    { id: "economy", provider: "openrouter", model: "openai/gpt-4o-mini" },
  ],
};

interface Installation {
  database: Database;
  engine: Engine;
  providers: ModelProviders;
  adminId: string;
  shopperId: string;
  /** Replaces what the provider answers, per model id, for the next calls. */
  behave: (modelId: string, behaviour: ProviderBehaviour) => void;
  drop: () => Promise<void>;
}

/**
 * A bootstrapped installation whose conversation model is wired to all three
 * routes, with a transport that answers from protocol fixtures rather than
 * from a network.
 */
async function createInstallation({
  allowance,
  models = configuration.models,
  providers = PROVIDERS,
}: {
  allowance?: DiagnosticAllowance;
  models?: ModelConfiguration["models"];
  providers?: Record<string, ModelProviderIdentity>;
} = {}): Promise<Installation> {
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
  await migrate(database);

  const engine = createEngine({
    database,
    setupToken: "unused-in-these-tests",
    identity: createFakeIdentityStore(database),
    services: { model: { providers } },
  });

  const adminId = await createAccount(database, "operator@example.com");
  const shopperId = await createAccount(database, "shopper@example.com");
  await database.transaction(async (transaction) => {
    await transaction("installation").insert({ initial_admin_created_at: transaction.fn.now() });
    await transaction("profiles").where({ id: adminId }).update({ role: "admin" });
  });

  // One transport per model, so each route can answer differently in a test.
  const transports = new Map<string, ReturnType<typeof fixtureTransport>>();
  const transportFor = (modelId: string) => {
    let transport = transports.get(modelId);
    if (!transport) {
      transport = fixtureTransport(wellBehaved);
      transports.set(modelId, transport);
    }
    return transport;
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    const model = models.find((candidate) => candidate.model === body.model);
    return transportFor(model?.id ?? "balanced").fetch(input, init);
  };

  const modelProviders = createModelProviders({
    engine,
    configuration: { ...configuration, models },
    ...(allowance ? { allowance } : {}),
    fetch: fetch as typeof globalThis.fetch,
  });

  return {
    database,
    engine,
    providers: modelProviders,
    adminId,
    shopperId,
    behave: (modelId, behaviour) => {
      transports.set(modelId, fixtureTransport(behaviour));
    },
    drop,
  };
}

async function discard(installation: Installation): Promise<void> {
  await installation.database.destroy();
  await installation.drop();
}

/** Cents the research ledger has spent, from the engine's own accounting. */
async function spentCents(installation: Installation): Promise<number> {
  const row = await installation.database("usage_events")
    .where({ kind: "settle" })
    .select(
      installation.database.raw("coalesce(sum(coalesce(actual_cents, estimated_cents)), 0)::int AS c"),
    )
    .first<{ c: number }>();
  return row?.c ?? 0;
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("admin model selection", () => {
  it("reports the configured provider behind each offered model", async () => {
    const installation = await createInstallation();
    const catalog = await installation.engine.administration.modelCatalog({
      id: installation.adminId,
    });
    expect(catalog.map((entry) => entry.id)).toEqual(["balanced", "thorough", "economy"]);
    expect(catalog[0]?.provider).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      route: "openai",
    });
    expect(catalog[2]?.provider?.route).toBe("openrouter");
    await discard(installation);
  });

  it("reports an offered model the deployment has no provider for", async () => {
    const installation = await createInstallation({
      providers: { balanced: PROVIDERS.balanced as ModelProviderIdentity },
    });
    const catalog = await installation.engine.administration.modelCatalog({
      id: installation.adminId,
    });
    expect(catalog.find((entry) => entry.id === "balanced")?.provider).toBeDefined();
    // Nothing is invented for an id with no adapter: an admin is told it is
    // unconfigured rather than offered it as if it worked.
    expect(catalog.find((entry) => entry.id === "thorough")?.provider).toBeUndefined();
    await discard(installation);
  });

  it("refuses the catalog to an ordinary account", async () => {
    const installation = await createInstallation();
    await expect(
      installation.engine.administration.modelCatalog({ id: installation.shopperId }),
    ).rejects.toBeInstanceOf(NotAnAdminError);
    await discard(installation);
  });

  it("lets an admin choose a configured model and reports it as active", async () => {
    const installation = await createInstallation();
    await installation.engine.accounts.updatePolicy(
      { id: installation.adminId },
      { modelId: "economy" },
    );
    const active = await installation.providers.active();
    expect(active).toMatchObject({
      id: "economy",
      provider: "openrouter",
      route: "openrouter",
      chosenByAdmin: true,
    });
    await discard(installation);
  });

  it("falls back to the deployment's own choice only when no admin has chosen", async () => {
    const installation = await createInstallation();
    const active = await installation.providers.active();
    expect(active).toMatchObject({ id: "balanced", chosenByAdmin: false });
    await discard(installation);
  });

  it("refuses a model the operator has not configured, for an admin too", async () => {
    const installation = await createInstallation();
    await expect(
      installation.providers.diagnose({ id: installation.adminId }, "unconfigured"),
    ).rejects.toBeInstanceOf(ModelNotConfiguredError);
    await discard(installation);
  });

  it("refuses a model outside the operator's ceiling even when a provider exists", async () => {
    const { schema, drop } = await createTestSchema(server);
    const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
    await migrate(database);
    const engine = createEngine({
      database,
      setupToken: "unused",
      identity: createFakeIdentityStore(database),
      policyCeilings: { modelIds: ["balanced"] },
      services: { model: { providers: PROVIDERS } },
    });
    const adminId = await createAccount(database, "operator@example.com");
    await database.transaction(async (transaction) => {
      await transaction("installation").insert({ initial_admin_created_at: transaction.fn.now() });
      await transaction("profiles").where({ id: adminId }).update({ role: "admin" });
    });
    const providers = createModelProviders({ engine, configuration });
    await expect(providers.diagnose({ id: adminId }, "economy")).rejects.toBeInstanceOf(
      ModelNotConfiguredError,
    );
    // The ceiling is also what the admin may choose from.
    await expect(
      engine.accounts.updatePolicy({ id: adminId }, { modelId: "economy" }),
    ).rejects.toBeInstanceOf(PolicyRefusedError);
    await database.destroy();
    await drop();
  });

  it("refuses diagnostics to an ordinary account", async () => {
    const installation = await createInstallation();
    const transport = fixtureTransport(wellBehaved);
    const providers = createModelProviders({
      engine: installation.engine,
      configuration,
      fetch: transport.fetch,
    });
    // An ordinary account may not diagnose: the engine's catalog refuses it
    // before a run is opened or a provider is contacted.
    await expect(
      providers.diagnose({ id: installation.shopperId }, "balanced"),
    ).rejects.toMatchObject({ name: "NotAnAdminError" });
    expect(transport.captured).toHaveLength(0);
    await discard(installation);
  });

  it("lists only models that have both an offered id and a provider", async () => {
    const installation = await createInstallation({
      models: [configuration.models[0] as ModelConfiguration["models"][number]],
    });
    const options = await installation.providers.options();
    expect(options.map((option) => option.id)).toEqual(["balanced"]);
    await discard(installation);
  });
});

describe("model readiness", () => {
  it("reports an unverified model as unverified, not as ready", async () => {
    const installation = await createInstallation();
    const [option] = await installation.providers.options();
    expect(option?.readiness).toBe("unverified");
    expect(await installation.providers.active()).toMatchObject({ readiness: "unverified" });
    await discard(installation);
  });

  it("reports readiness from an actual diagnostic, not from configuration", async () => {
    const installation = await createInstallation();
    await installation.providers.diagnose({ id: installation.adminId }, "balanced");
    expect((await installation.providers.options())[0]?.readiness).toBe("ready");
    expect(await installation.providers.active()).toMatchObject({ readiness: "ready" });
    await discard(installation);
  });

  it("reports a model with no credential as unconfigured without calling out", async () => {
    const installation = await createInstallation();
    const unkeyed = createModelProviders({
      engine: installation.engine,
      configuration: {
        providers: [{ id: "openai", route: "openai" }],
        models: [{ id: "balanced", provider: "openai", model: "gpt-4o-mini" }],
      },
      fetch: fixtureTransport(wellBehaved).fetch,
    });
    const report = await unkeyed.diagnose({ id: installation.adminId }, "balanced");
    expect(report.status).toBe("unconfigured");
    expect((await unkeyed.options())[0]?.readiness).toBe("unconfigured");
    await discard(installation);
  });

  it("reports a provider that cannot stream as incompatible", async () => {
    const installation = await createInstallation();
    installation.behave("balanced", notStreaming);
    const report = await installation.providers.diagnose({ id: installation.adminId }, "balanced");
    expect(report.status).toBe("incompatible");
    expect((await installation.providers.options())[0]?.readiness).toBe("incompatible");
    await discard(installation);
  });
});

describe("diagnostic charging", () => {
  it("charges a diagnostic to the research ledger as a model call", async () => {
    const installation = await createInstallation();
    const before = await spentCents(installation);
    const report = await installation.providers.diagnose({ id: installation.adminId }, "balanced");
    expect(report.status).toBe("ready");

    const events = await installation.database("usage_events")
      .where({ call_kind: "model" })
      .orderBy("created_at")
      .select(["kind", "reference"]);
    expect(events.map((event: { kind: string }) => event.kind)).toEqual(["reserve", "settle"]);
    // Both rows carry the same reference, which is how the ledger pairs them.
    expect(events[0]?.reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(events[1]?.reference).toBe(events[0]?.reference);
    // Nothing was known about the price, so the call keeps its reservation and
    // the ledger marks its cost as unknown rather than counting it as free.
    expect(await spentCents(installation)).toBe(before + 2);

    const usage = await installation.engine.research.usage({ id: installation.adminId });
    expect(usage.calls.model).toBe(1);
    expect(usage.costIncomplete).toBe(true);
    await discard(installation);
  });

  it("charges the token price when the operator states one", async () => {
    const installation = await createInstallation({
      models: [
        {
          id: "balanced",
          provider: "openai",
          model: "gpt-4o-mini",
          // 52 input and 14 output tokens are what the fixtures report.
          pricePerMillionTokens: { inputCents: 15_000, outputCents: 15_000 },
        },
      ],
    });
    const report = await installation.providers.diagnose({ id: installation.adminId }, "balanced");
    if (!("usage" in report)) throw new Error(`The diagnostic did not run: ${report.problem}`);
    expect(report.usage).toEqual({ inputTokens: 52, outputTokens: 14 });
    const settled = await installation.database("usage_events")
      .where({ kind: "settle" })
      .first<{ actual_cents: string; priced: boolean }>(["actual_cents", "priced"]);
    // 66 tokens at 1.5c per 100k is 0.099 cents, which rounds up to one cent
    // because a fraction of a cent cannot be recorded; whatever the worst-case
    // reservation held beyond that is released.
    expect(Number(settled?.actual_cents)).toBe(1);
    expect(settled?.priced).toBe(true);
    expect(await spentCents(installation)).toBe(1);
    await discard(installation);
  });

  it("bounds repeated diagnostics and says when the allowance is used up", async () => {
    const installation = await createInstallation({
      allowance: { maxRuns: 2, windowMs: 60_000 },
    });
    await installation.providers.diagnose({ id: installation.adminId }, "balanced");
    await installation.providers.diagnose({ id: installation.adminId }, "balanced");
    await expect(
      installation.providers.diagnose({ id: installation.adminId }, "balanced"),
    ).rejects.toBeInstanceOf(DiagnosticAllowanceExhaustedError);
    // The refusal is a refusal, not a charge: only the two runs were billed.
    const usage = await installation.engine.research.usage({ id: installation.adminId });
    expect(usage.calls.model).toBe(2);
    await discard(installation);
  });

  it("keeps diagnostics inside the research run's own ceiling", async () => {
    const installation = await createInstallation({ allowance: { maxRuns: 100, windowMs: 0 } });
    // A run may take two cents at a time, so the second diagnostic exceeds the
    // run's target and is refused by the same ledger a shopper's calls use.
    const first = await installation.providers.diagnose({ id: installation.adminId }, "balanced");
    expect(first.status).toBe("ready");
    await installation.database("research_runs").update({ run_target_cents: 3 });
    await expect(
      installation.providers.diagnose({ id: installation.adminId }, "balanced"),
    ).rejects.toMatchObject({ name: "ResearchAllowanceExhaustedError" });
    const runs = await installation.database("research_runs").select(["state", "pause_reason"]);
    expect(runs).toEqual([{ state: "paused", pause_reason: "run_target" }]);
    await discard(installation);
  });
});

describe("no silent provider fallback", () => {
  it("reports a failing provider instead of switching to another one", async () => {
    const installation = await createInstallation();
    const transport = fixtureTransport({
      stream: { status: 401, body: { error: { message: "bad key" } } },
      toolCall: { status: 401, body: { error: { message: "bad key" } } },
    });
    const providers = createModelProviders({
      engine: installation.engine,
      configuration,
      fetch: transport.fetch,
    });
    const report = await providers.diagnose({ id: installation.adminId }, "balanced");
    expect(report.status).toBe("failed");
    if (!("model" in report)) throw new Error("A provider failure is still a report");
    expect(report.model.provider).toBe("openai");
    // One provider was contacted, and only that one.
    expect(transport.captured).toHaveLength(1);
    expect(transport.captured[0]?.url).toContain("api.openai.com");
    await discard(installation);
  });

  it("keeps reporting the chosen model as active when its provider fails", async () => {
    const installation = await createInstallation();
    await installation.engine.accounts.updatePolicy(
      { id: installation.adminId },
      { modelId: "thorough" },
    );
    installation.behave("thorough", notStreaming);
    await installation.providers.diagnose({ id: installation.adminId }, "thorough");
    // A failing provider does not hand the conversation to another one.
    expect(await installation.providers.active()).toMatchObject({
      id: "thorough",
      readiness: "incompatible",
    });
    await discard(installation);
  });
});

describe("credential containment", () => {
  it("never reports or records a credential", async () => {
    const installation = await createInstallation();
    const report = await installation.providers.diagnose({ id: installation.adminId }, "balanced");
    const options = await installation.providers.options();
    const active = await installation.providers.active();
    const usage = await installation.engine.research.usage({ id: installation.adminId });
    const conversations = await installation.engine.conversations.list(installation.adminId);
    const run = await installation.engine.research.list(
      installation.adminId,
      conversations[0]?.id ?? "",
    );
    for (const value of [report, options, active, usage, run, conversations]) {
      expect(JSON.stringify(value)).not.toContain(API_KEY);
    }
    await discard(installation);
  });
});
