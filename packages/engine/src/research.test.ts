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
  DEFAULT_RESEARCH_LIMITS,
  NotAnAdminError,
  PolicyRefusedError,
  ResearchAllowanceExhaustedError,
  ResearchRunNotFoundError,
  ResearchRunStateError,
  UsageReservationRefusedError,
  type Engine,
  type Research,
  type ResearchCeilings,
} from "./index.ts";
import { createFakeIdentityStore } from "./testing/fake-identity-store.ts";

let server: Database;

interface Installation {
  database: Database;
  engine: Engine;
  research: Research;
  /** Moves the engine's clock, so no test has to wait for a limit. */
  advance: (milliseconds: number) => void;
  drop: () => Promise<void>;
}

/**
 * A bootstrapped installation with an admin, one shopper, and a conversation,
 * each test file getting its own throwaway schema.
 */
async function createInstallation({
  researchCeilings,
}: { researchCeilings?: ResearchCeilings } = {}): Promise<
  Installation & { adminId: string; shopperId: string; conversationId: string }
> {
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
  await migrate(database);

  // The clock starts at a fixed instant so a test can reason about a day.
  let current = new Date("2026-11-28T09:00:00.000Z");
  const engine = createEngine({
    database,
    setupToken: "unused-in-these-tests",
    identity: createFakeIdentityStore(database),
    ...(researchCeilings ? { researchCeilings } : {}),
    now: () => current,
  });

  const adminId = await createAccount(database, "operator@example.com");
  const shopperId = await createAccount(database, "shopper@example.com");
  // An installation always exists with at least one active admin, and the
  // database refuses any other state, so the fixture records both together.
  await database.transaction(async (transaction) => {
    await transaction("installation").insert({ initial_admin_created_at: transaction.fn.now() });
    await transaction("profiles").where({ id: adminId }).update({ role: "admin" });
  });

  const conversation = await engine.conversations.create(shopperId, { title: "Bike helmet" });
  return {
    database,
    engine,
    research: engine.research,
    advance: (milliseconds) => {
      current = new Date(current.getTime() + milliseconds);
    },
    drop,
    adminId,
    shopperId,
    conversationId: conversation.id,
  };
}

async function discard(installation: Installation): Promise<void> {
  await installation.database.destroy();
  await installation.drop();
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("research defaults", () => {
  it("bounds a run at EUR 0.50, its conversation at EUR 2, a shopper's day at EUR 5, 12 calls and 90 seconds", async () => {
    const installation = await createInstallation();

    expect(await installation.research.limits()).toEqual({
      runTargetCents: 50,
      conversationCeilingCents: 200,
      dailyCeilingCents: 500,
      callLimit: 12,
      timeLimitMs: 90_000,
    });
    expect(DEFAULT_RESEARCH_LIMITS).toEqual(await installation.research.limits());
    await discard(installation);
  });

  it("copies the limits in force onto the run, so a later change cannot rewrite it", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId } = installation;

    const run = await research.start(shopperId, conversationId);
    expect(run.limits).toEqual(DEFAULT_RESEARCH_LIMITS);
    expect(run.state).toBe("running");

    await research.updatePolicy({ id: adminId }, { callLimit: 4 });
    expect((await research.get(shopperId, run.id)).limits.callLimit).toBe(12);
    await discard(installation);
  });

  it("narrows the limits to the operator's ceiling without an admin doing anything", async () => {
    const installation = await createInstallation({
      researchCeilings: { runTargetCents: 25, callLimit: 3 },
    });

    expect(await installation.research.limits()).toEqual({
      ...DEFAULT_RESEARCH_LIMITS,
      runTargetCents: 25,
      callLimit: 3,
    });
    await discard(installation);
  });
});

describe("run lifecycle", () => {
  it("pauses, continues, and stops the same run while keeping its results", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId } = installation;

    const run = await research.start(shopperId, conversationId);
    await research.reserve(shopperId, run.id, {
      callKind: "model",
      pricing: { unitCents: 10 },
    });
    await research.recordResults(shopperId, run.id, 3);

    const paused = await research.pause(shopperId, run.id);
    expect(paused.state).toBe("paused");
    expect(paused.pauseReason).toBe("shopper");
    expect(paused.resultsRetained).toBe(3);
    // A paused run does no work, whatever it still has to spend.
    await expect(
      research.reserve(shopperId, run.id, { callKind: "model", pricing: { unitCents: 1 } }),
    ).rejects.toThrow(ResearchRunStateError);

    const resumed = await research.continue(shopperId, run.id);
    expect(resumed).toMatchObject({ id: run.id, state: "running", resultsRetained: 3 });
    expect(resumed.pauseReason).toBeUndefined();

    const stopped = await research.stop(shopperId, run.id);
    expect(stopped.state).toBe("stopped");
    expect(stopped.resultsRetained).toBe(3);
    expect(stopped.endedAt).toBeInstanceOf(Date);
    // A stopped run is final, so it is neither continued nor stopped twice.
    await expect(research.continue(shopperId, run.id)).rejects.toThrow(ResearchRunStateError);
    await expect(research.stop(shopperId, run.id)).rejects.toThrow(ResearchRunStateError);
    await discard(installation);
  });

  it("keeps the whole start, pause, continue and stop history of a run", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, database } = installation;

    const run = await research.start(shopperId, conversationId);
    await research.pause(shopperId, run.id);
    await research.continue(shopperId, run.id);
    const resumedCall = await research
      .reserve(shopperId, run.id, { callKind: "model", pricing: { unitCents: 1 } })
      .then(() => "allowed", (error: unknown) => (error instanceof Error ? error.name + ":" + error.message : String(error)));
    expect(resumedCall).toBe("allowed");
    await research.stop(shopperId, run.id);

    const events = await database("research_run_events")
      .where({ run_id: run.id })
      .orderBy("id")
      .select(["kind", "reason"]);
    expect(events).toEqual([
      { kind: "start", reason: null },
      { kind: "pause", reason: "shopper" },
      { kind: "resume", reason: null },
      { kind: "stop", reason: null },
    ]);
    await discard(installation);
  });

  it("answers not-found for another shopper's run and for one that does not exist", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, database } = installation;
    const strangerId = await createAccount(database, "stranger@example.com");
    const run = await research.start(shopperId, conversationId);

    await expect(research.get(strangerId, run.id)).rejects.toThrow(ResearchRunNotFoundError);
    await expect(research.pause(strangerId, run.id)).rejects.toThrow(ResearchRunNotFoundError);
    await expect(research.get(shopperId, "6b2f6c1e-0d6a-4f37-9a5c-2d0f8f7c1b11")).rejects.toThrow(
      ResearchRunNotFoundError,
    );
    // The stranger's own conversation is not the shopper's, so it cannot be
    // researched on the shopper's behalf either.
    const strangersConversation = await installation.engine.conversations.create(strangerId, {
      title: "Their own search",
    });
    await expect(research.start(shopperId, strangersConversation.id)).rejects.toThrow(
      ResearchRunNotFoundError,
    );
    await discard(installation);
  });
});

describe("accounting", () => {
  it("counts model calls, retrieval, retries, and paid fallbacks alike", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId } = installation;
    const run = await research.start(shopperId, conversationId);

    const kinds = ["model", "retrieval", "retry", "fallback"] as const;
    for (const callKind of kinds) {
      const reservation = await research.reserve(shopperId, run.id, {
        callKind,
        pricing: { unitCents: 5 },
      });
      await research.settle(shopperId, { reservationId: reservation.id, actualCents: 3 });
    }

    const settled = await research.get(shopperId, run.id);
    expect(settled.usage.calls).toBe(4);
    expect(settled.usage.spentCents).toBe(12);
    expect(settled.usage.reservedCents).toBe(0);

    const overview = await research.usage({ id: installation.adminId });
    expect(overview.calls).toEqual({ model: 1, retrieval: 1, retry: 1, fallback: 1 });
    expect(overview.spentCents).toBe(12);
    await discard(installation);
  });

  it("holds the conservative estimate until the call settles to what it actually cost", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId } = installation;
    const run = await research.start(shopperId, conversationId);

    // Ten units at 3 cents each: the estimate the allowance must cover.
    const reservation = await research.reserve(shopperId, run.id, {
      callKind: "model",
      pricing: { unitCents: 3, units: 10 },
    });
    expect(reservation).toMatchObject({ reservedCents: 30, priced: true });

    const held = await research.get(shopperId, run.id);
    expect(held.usage).toMatchObject({ reservedCents: 30, spentCents: 0, calls: 1 });
    // The day counts what is held, not only what is settled.
    expect((await research.dailyAllowance(shopperId)).usedCents).toBe(30);

    const settled = await research.settle(shopperId, { reservationId: reservation.id, actualCents: 18 });
    expect(settled.usage).toMatchObject({ reservedCents: 0, spentCents: 18, calls: 1 });
    expect((await research.dailyAllowance(shopperId)).usedCents).toBe(18);
    await discard(installation);
  });

  it("gives the whole estimate back when a call never happened", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId } = installation;
    const run = await research.start(shopperId, conversationId);

    const reservation = await research.reserve(shopperId, run.id, {
      callKind: "retrieval",
      pricing: { unitCents: 20 },
    });
    const released = await research.release(shopperId, reservation.id);

    expect(released.usage).toMatchObject({ reservedCents: 0, spentCents: 0, calls: 1 });
    expect((await research.dailyAllowance(shopperId)).usedCents).toBe(0);
    // A released call still counts against the call limit: it was work.
    expect(released.usage.calls).toBe(1);
    await discard(installation);
  });

  it("counts a retried request as the same call rather than buying it twice", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId } = installation;
    const run = await research.start(shopperId, conversationId);

    const first = await research.reserve(shopperId, run.id, {
      reference: "6b2f6c1e-0d6a-4f37-9a5c-2d0f8f7c1b11",
      callKind: "model",
      pricing: { unitCents: 10 },
    });
    const replayed = await research.reserve(shopperId, run.id, {
      reference: "6b2f6c1e-0d6a-4f37-9a5c-2d0f8f7c1b11",
      callKind: "model",
      pricing: { unitCents: 10 },
    });

    expect(replayed.id).toBe(first.id);
    expect((await research.get(shopperId, run.id)).usage.calls).toBe(1);
    expect((await research.dailyAllowance(shopperId)).usedCents).toBe(10);

    await research.settle(shopperId, { reservationId: first.id, actualCents: 8 });
    // A settlement is applied once: the second attempt is refused by name.
    await expect(
      research.settle(shopperId, { reservationId: first.id, actualCents: 8 }),
    ).rejects.toThrow(UsageReservationRefusedError);
    await expect(research.release(shopperId, first.id)).rejects.toThrow(
      UsageReservationRefusedError,
    );
    expect((await research.dailyAllowance(shopperId)).usedCents).toBe(8);
    await discard(installation);
  });

  it("answers not-found for another shopper's reservation", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, database } = installation;
    const strangerId = await createAccount(database, "stranger@example.com");
    const run = await research.start(shopperId, conversationId);
    const reservation = await research.reserve(shopperId, run.id, {
      callKind: "model",
      pricing: { unitCents: 10 },
    });

    // A reservation belongs to the run that made it, so settling or releasing
    // someone else's is indistinguishable from naming one that never existed.
    await expect(
      research.settle(strangerId, { reservationId: reservation.id, actualCents: 1 }),
    ).rejects.toThrow(ResearchRunNotFoundError);
    await expect(research.release(strangerId, reservation.id)).rejects.toThrow(
      ResearchRunNotFoundError,
    );
    expect((await research.get(shopperId, run.id)).usage.reservedCents).toBe(10);
    await discard(installation);
  });

  it("refuses a settlement above its own reservation, so an estimate is never quietly exceeded", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId } = installation;
    const run = await research.start(shopperId, conversationId);
    const reservation = await research.reserve(shopperId, run.id, {
      callKind: "model",
      pricing: { unitCents: 10 },
    });

    await expect(
      research.settle(shopperId, { reservationId: reservation.id, actualCents: 11 }),
    ).rejects.toThrow(UsageReservationRefusedError);
    expect((await research.get(shopperId, run.id)).usage.reservedCents).toBe(10);
    await discard(installation);
  });

  it("keeps the ledger append-only, so no limit can be reached by editing history", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, database } = installation;
    const run = await research.start(shopperId, conversationId);
    await research.reserve(shopperId, run.id, { callKind: "model", pricing: { unitCents: 10 } });

    await expect(database("usage_events").update({ estimated_cents: 0 })).rejects.toThrow(
      /cannot be changed/,
    );
    await expect(database("usage_events").delete()).rejects.toThrow(/cannot be changed/);
    await discard(installation);
  });
});

describe("run target", () => {
  it("pauses the run at its own target and refuses the call that would pass it", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId } = installation;
    await research.updatePolicy({ id: adminId }, { runTargetCents: 20 });
    const run = await research.start(shopperId, conversationId);

    const first = await research.reserve(shopperId, run.id, {
      callKind: "model",
      pricing: { unitCents: 15 },
    });
    await research.settle(shopperId, { reservationId: first.id, actualCents: 15 });

    await expect(
      research.reserve(shopperId, run.id, { callKind: "model", pricing: { unitCents: 6 } }),
    ).rejects.toThrow(ResearchAllowanceExhaustedError);
    const exhausted = await research.get(shopperId, run.id);
    expect(exhausted.state).toBe("paused");
    expect(exhausted.pauseReason).toBe("run_target");
    expect(exhausted.usage.spentCents).toBe(15);
    await discard(installation);
  });

  it("pauses the run as soon as a settlement reaches its target", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId } = installation;
    await research.updatePolicy({ id: adminId }, { runTargetCents: 20 });
    const run = await research.start(shopperId, conversationId);
    const reservation = await research.reserve(shopperId, run.id, {
      callKind: "model",
      pricing: { unitCents: 20 },
    });

    const settled = await research.settle(shopperId, {
      reservationId: reservation.id,
      actualCents: 20,
    });

    expect(settled.state).toBe("paused");
    expect(settled.pauseReason).toBe("run_target");
    await discard(installation);
  });
});

describe("conversation ceiling", () => {
  it("counts every run on a conversation against the same ceiling", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId } = installation;
    await research.updatePolicy({ id: adminId }, { conversationCeilingCents: 30 });

    const first = await research.start(shopperId, conversationId);
    const reservation = await research.reserve(shopperId, first.id, {
      callKind: "model",
      pricing: { unitCents: 20 },
    });
    await research.settle(shopperId, { reservationId: reservation.id, actualCents: 20 });
    await research.stop(shopperId, first.id);

    // A new run on the same conversation is not a new allowance.
    const second = await research.start(shopperId, conversationId);
    await expect(
      research.reserve(shopperId, second.id, { callKind: "model", pricing: { unitCents: 11 } }),
    ).rejects.toThrow(ResearchAllowanceExhaustedError);
    expect((await research.get(shopperId, second.id)).pauseReason).toBe("conversation_ceiling");

    // What still fits is still allowed, once the shopper continues the run
    // they paused by reaching the ceiling.
    await research.continue(shopperId, second.id);
    const fits = await research.reserve(shopperId, second.id, {
      callKind: "model",
      pricing: { unitCents: 10 },
    });
    expect(fits.reservedCents).toBe(10);
    await discard(installation);
  });

  it("refuses to start a run on a conversation that has spent its ceiling", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId } = installation;
    await research.updatePolicy({ id: adminId }, { conversationCeilingCents: 10 });
    const run = await research.start(shopperId, conversationId);
    const reservation = await research.reserve(shopperId, run.id, {
      callKind: "model",
      pricing: { unitCents: 10 },
    });
    await research.settle(shopperId, { reservationId: reservation.id, actualCents: 10 });
    await research.stop(shopperId, run.id);

    await expect(research.start(shopperId, conversationId)).rejects.toThrow(
      ResearchAllowanceExhaustedError,
    );
    await discard(installation);
  });
});

describe("daily ceiling", () => {
  it("bounds a shopper's day across every conversation and resumes on the next day", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId, engine, advance } = installation;
    await research.updatePolicy({ id: adminId }, { dailyCeilingCents: 40 });

    const run = await research.start(shopperId, conversationId);
    const first = await research.reserve(shopperId, run.id, {
      callKind: "model",
      pricing: { unitCents: 30 },
    });
    await research.settle(shopperId, { reservationId: first.id, actualCents: 30 });

    // A different conversation draws on the same day.
    const other = await engine.conversations.create(shopperId, { title: "Winter coat" });
    const otherRun = await research.start(shopperId, other.id);
    await expect(
      research.reserve(shopperId, otherRun.id, {
        callKind: "retrieval",
        pricing: { unitCents: 11 },
      }),
    ).rejects.toThrow(ResearchAllowanceExhaustedError);
    expect((await research.get(shopperId, otherRun.id)).pauseReason).toBe("daily_ceiling");

    const allowance = await research.dailyAllowance(shopperId);
    expect(allowance).toMatchObject({ ceilingCents: 40, usedCents: 30, remainingCents: 10 });

    // Tomorrow is a new day, without anything being reset by hand.
    advance(24 * 60 * 60 * 1_000);
    expect((await research.dailyAllowance(shopperId)).usedCents).toBe(0);
    const tomorrowRun = await research.start(shopperId, other.id);
    const tomorrow = await research.reserve(shopperId, tomorrowRun.id, {
      callKind: "retrieval",
      pricing: { unitCents: 11 },
    });
    expect(tomorrow.reservedCents).toBe(11);
    await discard(installation);
  });
});

describe("call limit", () => {
  it("caps the calls a run may make, however cheap they are", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId } = installation;
    await research.updatePolicy({ id: adminId }, { callLimit: 2 });
    const run = await research.start(shopperId, conversationId);

    for (const reference of [
      "6b2f6c1e-0d6a-4f37-9a5c-2d0f8f7c1b01",
      "6b2f6c1e-0d6a-4f37-9a5c-2d0f8f7c1b02",
    ]) {
      const reservation = await research.reserve(shopperId, run.id, {
        reference,
        callKind: "retrieval",
        pricing: { unitCents: 1 },
      });
      await research.release(shopperId, reservation.id);
    }

    await expect(
      research.reserve(shopperId, run.id, { callKind: "retrieval", pricing: { unitCents: 1 } }),
    ).rejects.toThrow(ResearchAllowanceExhaustedError);
    const exhausted = await research.get(shopperId, run.id);
    expect(exhausted.state).toBe("paused");
    expect(exhausted.pauseReason).toBe("call_limit");
    expect(exhausted.usage.calls).toBe(2);
    await discard(installation);
  });
});

describe("time limit", () => {
  it("pauses a run whose settled call used up its ninety seconds", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, advance } = installation;
    const run = await research.start(shopperId, conversationId);
    const reservation = await research.reserve(shopperId, run.id, {
      callKind: "model",
      pricing: { unitCents: 1 },
    });

    // The call itself took the whole allowance, which the settlement reports.
    advance(90_001);
    const settled = await research.settle(shopperId, {
      reservationId: reservation.id,
      actualCents: 1,
      durationMs: 90_001,
    });

    expect(settled.state).toBe("paused");
    expect(settled.pauseReason).toBe("time_limit");
    // Its working time is banked, so the time spent paused is not charged.
    expect(settled.usage.durationMs).toBe(90_001);
    await discard(installation);
  });

  it("refuses a call whose own expected duration would pass the limit", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId } = installation;
    const run = await research.start(shopperId, conversationId);

    // Ninety seconds is the whole allowance, so a call that expects to take
    // even one millisecond of it is refused before it starts.
    await expect(
      research.reserve(shopperId, run.id, {
        callKind: "model",
        pricing: { unitCents: 1 },
        estimatedDurationMs: 90_001,
      }),
    ).rejects.toThrow(ResearchAllowanceExhaustedError);
    const timedOut = await research.get(shopperId, run.id);
    expect(timedOut.state).toBe("paused");
    expect(timedOut.pauseReason).toBe("time_limit");
    await discard(installation);
  });

  it("refuses a call whose own expected duration would pass the limit", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId } = installation;
    const run = await research.start(shopperId, conversationId);

    await expect(
      research.reserve(shopperId, run.id, {
        callKind: "model",
        pricing: { unitCents: 1 },
        estimatedDurationMs: 90_001,
      }),
    ).rejects.toThrow(ResearchAllowanceExhaustedError);
    expect((await research.get(shopperId, run.id)).pauseReason).toBe("time_limit");
    await discard(installation);
  });
});

describe("unknown pricing", () => {
  it("marks the accounting incomplete while still enforcing the call and time limits", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId, advance } = installation;
    await research.updatePolicy({ id: adminId }, { callLimit: 3 });
    const run = await research.start(shopperId, conversationId);

    // No price is known for the fallback, so nothing can be held for it.
    const reservation = await research.reserve(shopperId, run.id, { callKind: "fallback", pricing: {} });
    expect(reservation).toMatchObject({ reservedCents: 0, priced: false });

    const unsettled = await research.settle(shopperId, { reservationId: reservation.id });
    expect(unsettled.usage).toMatchObject({ calls: 1, spentCents: 0, costIncomplete: true });
    expect((await research.dailyAllowance(shopperId)).costIncomplete).toBe(true);

    // The call limit still applies: three calls is three calls, priced or not.
    for (const reference of [
      "6b2f6c1e-0d6a-4f37-9a5c-2d0f8f7c1b02",
      "6b2f6c1e-0d6a-4f37-9a5c-2d0f8f7c1b03",
    ]) {
      const further = await research.reserve(shopperId, run.id, {
        reference,
        callKind: "model",
        pricing: { unitCents: 1 },
      });
      await research.release(shopperId, further.id);
    }
    await expect(
      research.reserve(shopperId, run.id, { callKind: "model", pricing: { unitCents: 1 } }),
    ).rejects.toThrow(ResearchAllowanceExhaustedError);

    const overview = await research.usage({ id: adminId });
    expect(overview.costIncomplete).toBe(true);
    expect(overview.byUser.find((user) => user.userId === shopperId)?.costIncomplete).toBe(true);
    await discard(installation);
  });

  it("marks a call incomplete when its price becomes unknown after it was reserved", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId } = installation;
    const run = await research.start(shopperId, conversationId);
    const reservation = await research.reserve(shopperId, run.id, {
      callKind: "model",
      pricing: { unitCents: 10 },
    });

    // The adapter could not learn what the call cost: the estimate stands, and
    // the figure is labelled rather than presented as exact.
    const settled = await research.settle(shopperId, { reservationId: reservation.id });
    expect(settled.usage).toMatchObject({ spentCents: 10, costIncomplete: true });
    await discard(installation);
  });

  it("keeps the time limit in force when nothing can be priced", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, advance } = installation;
    const run = await research.start(shopperId, conversationId);

    advance(90_001);
    await expect(
      research.reserve(shopperId, run.id, { callKind: "model", pricing: {} }),
    ).rejects.toThrow(ResearchAllowanceExhaustedError);
    expect((await research.get(shopperId, run.id)).pauseReason).toBe("time_limit");
    await discard(installation);
  });
});

describe("concurrency", () => {
  it("lets only one of two concurrent runs reserve the last unit of the day", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId, engine } = installation;
    await research.updatePolicy({ id: adminId }, { dailyCeilingCents: 30 });

    const first = await research.start(shopperId, conversationId);
    const secondConversation = await engine.conversations.create(shopperId, {
      title: "Espresso machine",
    });
    const second = await research.start(shopperId, secondConversation.id);

    // Each reservation fits the day on its own; together they do not.
    const attempts = await Promise.allSettled([
      research.reserve(shopperId, first.id, { callKind: "model", pricing: { unitCents: 20 } }),
      research.reserve(shopperId, second.id, { callKind: "model", pricing: { unitCents: 20 } }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const refused = attempts.find((attempt) => attempt.status === "rejected");
    expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(
      ResearchAllowanceExhaustedError,
    );
    const allowance = await research.dailyAllowance(shopperId);
    expect(allowance.usedCents).toBe(20);
    expect(allowance.remainingCents).toBe(10);
    await discard(installation);
  });

  it("lets only one of two concurrent runs reserve the last unit of a conversation", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId } = installation;
    await research.updatePolicy({ id: adminId }, { conversationCeilingCents: 25 });

    // Two runs on the same conversation, which is what a shopper gets by
    // stopping one and starting another.
    const first = await research.start(shopperId, conversationId);
    const second = await research.start(shopperId, conversationId);

    const attempts = await Promise.allSettled([
      research.reserve(shopperId, first.id, { callKind: "model", pricing: { unitCents: 15 } }),
      research.reserve(shopperId, second.id, { callKind: "model", pricing: { unitCents: 15 } }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const stored = await installation.database("usage_events")
      .where({ kind: "reserve" })
      .select("estimated_cents");
    expect(stored.map((row) => Number(row.estimated_cents))).toEqual([15]);
    await discard(installation);
  });

  it("lets only one of two concurrent runs reserve the last unit of a day across shoppers' runs", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId, engine, database } = installation;
    await research.updatePolicy({ id: adminId }, { dailyCeilingCents: 30 });
    const secondShopper = await createAccount(database, "second@example.com");
    const secondConversation = await engine.conversations.create(secondShopper, {
      title: "Coffee grinder",
    });

    const mine = await research.start(shopperId, conversationId);
    const theirs = await research.start(secondShopper, secondConversation.id);

    // Two separate accounts have separate days, so both may spend. What must
    // not happen is one account spending twice its day: the pair below is on
    // one account, and only one of them may win.
    const attempts = await Promise.allSettled([
      research.reserve(shopperId, mine.id, { callKind: "model", pricing: { unitCents: 20 } }),
      research.reserve(shopperId, mine.id, { callKind: "model", pricing: { unitCents: 20 } }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect((await research.dailyAllowance(shopperId)).usedCents).toBe(20);
    expect((await research.dailyAllowance(secondShopper)).usedCents).toBe(0);
    expect(theirs.state).toBe("running");
    await discard(installation);
  });

  it("allows two concurrent reservations that both fit", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId } = installation;
    const run = await research.start(shopperId, conversationId);

    // Serialising the accounting must not mean refusing work that fits: the
    // default day allows both.
    const attempts = await Promise.all([
      research.reserve(shopperId, run.id, { callKind: "model", pricing: { unitCents: 20 } }),
      research.reserve(shopperId, run.id, { callKind: "retrieval", pricing: { unitCents: 20 } }),
    ]);

    expect(attempts).toHaveLength(2);
    expect((await research.dailyAllowance(shopperId)).usedCents).toBe(40);
    await discard(installation);
  });
});

describe("continuation", () => {
  it("preserves conversation and daily usage when a paused run continues", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId } = installation;
    await research.updatePolicy({ id: adminId }, {
      runTargetCents: 40,
      conversationCeilingCents: 60,
      dailyCeilingCents: 70,
    });

    const run = await research.start(shopperId, conversationId);
    const first = await research.reserve(shopperId, run.id, {
      callKind: "model",
      pricing: { unitCents: 30 },
    });
    await research.settle(shopperId, { reservationId: first.id, actualCents: 30 });
    await research.recordResults(shopperId, run.id, 5);
    await research.pause(shopperId, run.id);

    const resumed = await research.continue(shopperId, run.id);

    // Nothing is reset by continuing: the run, its conversation, and the day
    // all still carry what was already spent.
    expect(resumed.usage.spentCents).toBe(30);
    expect(resumed.usage.calls).toBe(1);
    expect(resumed.resultsRetained).toBe(5);
    expect((await research.dailyAllowance(shopperId)).usedCents).toBe(30);

    // The run's own target still has ten cents left, so a fifteen cent call is
    // refused even though a fresh run would have had the whole forty.
    await expect(
      research.reserve(shopperId, run.id, { callKind: "model", pricing: { unitCents: 15 } }),
    ).rejects.toThrow(ResearchAllowanceExhaustedError);
    expect((await research.get(shopperId, run.id)).pauseReason).toBe("run_target");
    await discard(installation);
  });

  it("does not let a continuation escape the conversation ceiling", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId } = installation;
    await research.updatePolicy({ id: adminId }, { conversationCeilingCents: 20 });
    const run = await research.start(shopperId, conversationId);
    const reservation = await research.reserve(shopperId, run.id, {
      callKind: "model",
      pricing: { unitCents: 20 },
    });
    await research.settle(shopperId, { reservationId: reservation.id, actualCents: 20 });
    // Settling at the ceiling is itself the limit: the run pauses, and a
    // continuation resumes the same run rather than a fresh one.
    expect((await research.get(shopperId, run.id)).pauseReason).toBe("conversation_ceiling");
    await research.continue(shopperId, run.id);

    // The conversation's ceiling is not reset by continuing, so the very next
    // call is refused against it.
    await expect(
      research.reserve(shopperId, run.id, { callKind: "model", pricing: { unitCents: 1 } }),
    ).rejects.toThrow(ResearchAllowanceExhaustedError);
    expect((await research.get(shopperId, run.id)).pauseReason).toBe("conversation_ceiling");
    await discard(installation);
  });
});

describe("administrator policy", () => {
  it("lets an admin change the limits within the environment ceiling", async () => {
    // The operator allows a wider day than the application's own default, so an
    // admin may choose it; nothing beyond the operator's ceiling is reachable.
    const installation = await createInstallation({
      researchCeilings: { dailyCeilingCents: 600 },
    });
    const { research, adminId } = installation;

    const changed = await research.updatePolicy({ id: adminId }, { dailyCeilingCents: 600 });

    expect(changed.limits).toMatchObject({ dailyCeilingCents: 600 });
    expect(changed.ceilings).toMatchObject({ dailyCeilingCents: 600 });
    expect(changed.updatedAt).toBeInstanceOf(Date);
    expect((await research.limits()).dailyCeilingCents).toBe(600);
    await discard(installation);
  });

  it("rejects an override above the environment ceiling instead of clamping it", async () => {
    const installation = await createInstallation({
      researchCeilings: { runTargetCents: 40, callLimit: 8 },
    });
    const { research, adminId } = installation;

    await expect(
      research.updatePolicy({ id: adminId }, { runTargetCents: 41 }),
    ).rejects.toThrow(PolicyRefusedError);
    await expect(research.updatePolicy({ id: adminId }, { callLimit: 9 })).rejects.toThrow(
      PolicyRefusedError,
    );
    // Nothing was written by a refused change.
    expect(await research.limits()).toMatchObject({ runTargetCents: 40, callLimit: 8 });
    await discard(installation);
  });

  it("rejects a limit that is not a positive number", async () => {
    const installation = await createInstallation();
    const { research, adminId } = installation;

    await expect(research.updatePolicy({ id: adminId }, { callLimit: -1 })).rejects.toThrow(
      PolicyRefusedError,
    );
    await expect(
      research.updatePolicy({ id: adminId }, { runTargetCents: Number.NaN }),
    ).rejects.toThrow(PolicyRefusedError);
    await discard(installation);
  });

  it("refuses research policy and usage to an ordinary account", async () => {
    const installation = await createInstallation();
    const { research, shopperId, database } = installation;
    const actor = { id: shopperId };

    await expect(research.policy(actor)).rejects.toThrow(NotAnAdminError);
    await expect(research.updatePolicy(actor, { callLimit: 1 })).rejects.toThrow(NotAnAdminError);
    await expect(research.usage(actor)).rejects.toThrow(NotAnAdminError);
    expect(await research.limits()).toEqual(DEFAULT_RESEARCH_LIMITS);
    await discard(installation);
  });

  it("refuses research policy to a disabled admin", async () => {
    const installation = await createInstallation();
    const { research, engine, adminId, database } = installation;
    const second = await createAccount(database, "second-admin@example.com");
    await engine.accounts.promote({ id: adminId }, second);
    await engine.accounts.disable({ id: adminId }, second);

    await expect(research.updatePolicy({ id: second }, { callLimit: 1 })).rejects.toThrow(
      NotAnAdminError,
    );
    await discard(installation);
  });
});

describe("aggregate usage", () => {
  it("reports totals per user and per conversation without any private content", async () => {
    const installation = await createInstallation();
    const { research, shopperId, conversationId, adminId, engine } = installation;
    await engine.conversations.appendMessage(shopperId, conversationId, {
      role: "user",
      content: "I need a MIPS helmet under 200 euros.",
    });
    await engine.requirements.set(shopperId, conversationId, {
      hardConstraints: [{ statement: "Must have MIPS" }],
      preferences: [{ statement: "Prefer dark colours" }],
    });

    const run = await research.start(shopperId, conversationId);
    for (const [callKind, actualCents] of [
      ["model", 12],
      ["retrieval", 4],
    ] as const) {
      const reservation = await research.reserve(shopperId, run.id, {
        callKind,
        pricing: { unitCents: 20 },
      });
      await research.settle(shopperId, { reservationId: reservation.id, actualCents });
    }

    const overview = await research.usage({ id: adminId });
    expect(overview.calls).toEqual({ model: 1, retrieval: 1, retry: 0, fallback: 0 });
    expect(overview.spentCents).toBe(16);
    expect(overview.reservedCents).toBe(0);
    expect(overview.costIncomplete).toBe(false);
    expect(overview.byUser).toEqual([
      { userId: shopperId, calls: 2, spentCents: 16, costIncomplete: false },
    ]);
    expect(overview.byConversation).toEqual([
      { conversationId, calls: 2, spentCents: 16 },
    ]);
    expect(overview.runs).toEqual({ running: 1, paused: 0, stopped: 0, completed: 0 });

    // Nothing a shopper wrote may travel with the figures: not the message,
    // not the requirement, and not even the conversation's title.
    const serialised = JSON.stringify(overview);
    expect(serialised).not.toContain("MIPS");
    expect(serialised).not.toContain("dark colours");
    expect(serialised).not.toContain("Bike helmet");
    await discard(installation);
  });
});
