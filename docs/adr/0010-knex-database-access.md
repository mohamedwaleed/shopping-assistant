# Use Knex for PostgreSQL access

The user explicitly selected Knex for database connections and queries. Use Knex with pg for shared application storage, transactions, parameterized PostgreSQL-specific queries and application migrations rather than a separate ORM; retain per-process pool lifecycle and validated workspace authorization. The existing Better Auth choice requires a compatible Knex-backed adapter and verified schema/atomicity integration rather than assuming native Knex support or allowing competing schema migration authorities.
