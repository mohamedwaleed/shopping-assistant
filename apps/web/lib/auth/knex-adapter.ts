// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { createAdapterFactory, type CleanedWhere, type CustomAdapter } from "better-auth/adapters";

/**
 * Better Auth ships no Knex adapter, so identity tables are read and written
 * through the documented custom-adapter interface over the shared Knex pool
 * (docs/adr/0010). Columns use the snake_case names declared by the
 * `identity_and_workspaces` migration; the factory handles camelCase field
 * names, dates, JSON and id generation, and Knex parameterises every value.
 */
export interface KnexAuthAdapterOptions {
  db: Knex;
  /** Test-only adapter conformance logging; never enabled in the application. */
  debugLogs?: boolean;
}

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function applyWhere(query: Knex.QueryBuilder, where: CleanedWhere[]): Knex.QueryBuilder {
  for (const condition of where) {
    const field = snakeCase(condition.field);
    const connector = condition.connector === "OR" ? "orWhere" : "where";
    switch (condition.operator) {
      case "eq":
        query[connector](field, condition.value);
        break;
      case "ne":
        query[connector](field, "<>", condition.value);
        break;
      case "lt":
        query[connector](field, "<", condition.value);
        break;
      case "lte":
        query[connector](field, "<=", condition.value);
        break;
      case "gt":
        query[connector](field, ">", condition.value);
        break;
      case "gte":
        query[connector](field, ">=", condition.value);
        break;
      case "in":
        query[connector](field, "in", Array.isArray(condition.value) ? condition.value : []);
        break;
      case "not_in":
        query[connector](field, "not in", Array.isArray(condition.value) ? condition.value : []);
        break;
      case "contains":
        query[connector](field, "like", `%${String(condition.value)}%`);
        break;
      case "starts_with":
        query[connector](field, "like", `${String(condition.value)}%`);
        break;
      case "ends_with":
        query[connector](field, "like", `%${String(condition.value)}`);
        break;
    }
  }
  return query;
}

function project(select: string[] | undefined): string[] | undefined {
  return select && select.length > 0 ? select : undefined;
}

/**
 * Columns are declared in snake_case by the migration, while the adapter
 * factory speaks camelCase field names; translate physical names on the way in
 * and back again on the way out.
 */
function toColumn(data: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) row[snakeCase(key)] = value;
  return row;
}

function toField<T>(row: Record<string, unknown> | null | undefined): T | null {
  if (!row) return null;
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    data[key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return data as T;
}

function buildAdapter(runner: Knex | Knex.Transaction): CustomAdapter {
  return {
    create: async <T>({ model, data }: { model: string; data: Record<string, unknown> }) => {
      const [row] = await runner(model).insert(toColumn(data)).returning("*");
      return toField<T>(row) ?? ({} as T);
    },

    findOne: async <T>({
      model,
      where,
      select,
    }: {
      model: string;
      where: CleanedWhere[];
      select?: string[] | undefined;
    }) => {
      const columns = project(select)?.map(snakeCase);
      const row = await applyWhere(runner(model).select(columns ?? "*"), where).first();
      return toField<T>(row);
    },

    findMany: async <T>({
      model,
      where,
      select,
      limit,
      offset,
      sortBy,
    }: {
      model: string;
      where?: CleanedWhere[] | undefined;
      select?: string[] | undefined;
      limit: number;
      offset?: number | undefined;
      sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
    }) => {
      const columns = project(select)?.map(snakeCase);
      let query = applyWhere(runner(model).select(columns ?? "*"), where ?? []);
      if (sortBy) query = query.orderBy(snakeCase(sortBy.field), sortBy.direction);
      if (offset) query = query.offset(offset);
      const rows: Record<string, unknown>[] = await query.limit(limit);
      return rows.map((row) => toField<T>(row) ?? ({} as T));
    },

    count: async ({ model, where }: { model: string; where?: CleanedWhere[] | undefined }) => {
      const row = await applyWhere(runner(model), where ?? []).count("* as count").first();
      return Number(row?.count ?? 0);
    },

    update: async <T>({
      model,
      where,
      update,
    }: {
      model: string;
      where: CleanedWhere[];
      update: T;
    }) => {
      if (where.length === 0) return null;
      const [row] = await applyWhere(runner(model), where)
        .update(toColumn(update as Record<string, unknown>))
        .returning("*");
      return toField<T>(row);
    },

    updateMany: async ({
      model,
      where,
      update,
    }: {
      model: string;
      where: CleanedWhere[];
      update: Record<string, unknown>;
    }) => {
      if (where.length === 0) return 0;
      return applyWhere(runner(model), where).update(toColumn(update));
    },

    delete: async ({ model, where }: { model: string; where: CleanedWhere[] }) => {
      if (where.length === 0) return;
      await applyWhere(runner(model), where).delete();
    },

    deleteMany: async ({ model, where }: { model: string; where: CleanedWhere[] }) => {
      if (where.length === 0) return 0;
      return applyWhere(runner(model), where).delete();
    },

    // Single-use credentials are consumed with one statement so concurrent
    // callers cannot both read the same row before either deletes it. Only the
    // first deleted row is returned, never more than one.
    consumeOne: async <T>({
      model,
      where,
    }: {
      model: string;
      where: CleanedWhere[];
    }) => {
      if (where.length === 0) return null;
      const rows = await applyWhere(runner(model), where).delete().returning("*");
      return toField<T>(rows[0]);
    },

    incrementOne: async <T>({
      model,
      where,
      increment,
      set,
    }: {
      model: string;
      where: CleanedWhere[];
      increment: Record<string, number>;
      set?: Record<string, unknown> | undefined;
    }) => {
      if (where.length === 0) return null;
      const changes = toColumn(set ?? {});
      for (const [field, delta] of Object.entries(increment)) {
        changes[snakeCase(field)] = runner.raw("?? + ?", [snakeCase(field), delta]);
      }
      const [row] = await applyWhere(runner(model), where).update(changes).returning("*");
      return toField<T>(row);
    },
  };
}

export function knexAuthAdapter({ db, debugLogs = false }: KnexAuthAdapterOptions) {
  return createAdapterFactory({
    config: {
      adapterId: "knex",
      adapterName: "Knex",
      usePlural: false,
      supportsDates: true,
      supportsJSON: true,
      supportsBooleans: true,
      supportsNumericIds: false,
      supportsUUIDs: false,
      supportsArrays: false,
      debugLogs,
      // Identity writes join the caller's transaction, so a failed sign-up
      // leaves no half-created user or credential account behind.
      transaction: (callback) =>
        db.transaction((trx) =>
          callback(
            createAdapterFactory({
              config: {
                adapterId: "knex",
                adapterName: "Knex (transaction)",
                usePlural: false,
                supportsDates: true,
                supportsJSON: true,
                supportsBooleans: true,
                supportsNumericIds: false,
                supportsUUIDs: false,
                supportsArrays: false,
                transaction: false,
              },
              adapter: () => buildAdapter(trx),
            })({}),
          ),
        ),
    },
    adapter: () => buildAdapter(db),
  });
}
