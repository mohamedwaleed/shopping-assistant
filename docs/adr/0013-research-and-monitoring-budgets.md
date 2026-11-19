# Pause provider work when a research or monitoring budget is exhausted

Budgets are a core concern (`packages/core/src/models/budgets.ts`), stored in
PostgreSQL through Knex migrations, so the worker, the HTTP API and any future
MCP adapter enforce the same allowances. The AI SDK never decides whether a
call may happen; core grants or refuses a reservation first, and the adapter
only makes calls it was granted.

## Two pools, never one

`interactive` (research a shopper is waiting for) and `background` (scheduled
monitoring) are separate allowances with separate windows. Exhausting one has
no effect on the other: `budget_periods` is unique on
`(workspace_id, pool, window_started_at)`, and usage is summed per period, so
the pools cannot consume each other's units. Both roll over on a fixed
`BUDGET_WINDOW_HOURS` boundary anchored from the clock, which is injected in
tests — nothing sleeps.

## Installation ceilings cannot be bypassed

`budget_allowances` holds one installation row per pool (the ceiling) and an
optional workspace row (an override). Three guards stack:

1. A workspace override is **clamped on write** to the current ceiling, so what
   is stored can never exceed what may be spent.
2. On read, the effective limit is `min(override, ceiling)` per unit — never a
   sum, never the override alone.
3. An override is only applied at all once the administrator has written a
   `workspace_budget_permissions` row allowing it; without that row a stored
   override is ignored.

Hard code ceilings (`MAX_ALLOWANCE`) clamp every row regardless, and only
`installation.manage` may set a ceiling or a permission. Naming another
workspace in a request is an installation-level action, so it needs that role
and the workspace must exist.

## Concurrency: reservations, not counters

Each provider call takes a reservation row. `reserve()` runs one transaction
that:

1. ensures the period row exists (`ON CONFLICT ... DO NOTHING` on the unique
   window key),
2. locks it with `SELECT ... FOR UPDATE`,
3. recomputes usage from `budget_reservations` in that window,
4. writes the reservation or returns the pause.

The lock serializes every concurrent reservation for that workspace and pool,
so the second caller blocks until the first commits and then sees its
reservation. A test fires eight simultaneous reservations against a four-call
allowance and asserts exactly four succeed and four are refused, with four rows
stored. No in-memory lock could hold across processes, which is why this is
row locking in PostgreSQL.

## Conservative estimates, and the higher of the two

No provider publishes an exact pre-call price, so each reservation is charged
a conservative estimate (`estimateCallCost`, disclosed to the user as
`estimates.assumption`): the whole context counted as input, the whole output
allowance counted as produced, and nothing assumed cached or free. On settle
the charge is `max(estimate, reported)`, so an under-reported usage figure can
never buy allowance back. Reservations that are never settled expire after
`RESERVATION_TTL_SECONDS` and stop holding allowance; the work they belonged to
has already failed by then.

## Cancellation and bounded retries

- **Released** means the call never reached the provider: the reservation is
  zeroed and costs nothing.
- **Settled** means the provider was contacted. A cancellation after dispatch
  is settled, not released, because the spend already happened.
- Retries are charged each time. `attempt` is carried on the reservation and
  capped by `MAX_BUDGET_ATTEMPTS`; a fourth attempt is refused with
  `budget-retry-exhausted` before any provider call.

## Consent and fallback

Background work on a workspace's own key needs an explicit
`workspace_personal_key_consents` row (`budget-consent-required` otherwise).
Without it the work pauses; it never silently moves to the installation
account. A paid provider fallback is reported as `paidAllowed: false` — the
budget engine has no path that switches provider or account, and a grant
carries the exact model the registry resolved, so a caller cannot reserve for
one model and call another.

## Pauses are visible

`budget-exhausted` carries the pool, reason, unit, limit and used count, and
the usage view reports the same `paused` structure per pool. The settings
screen renders both, with the ceiling, the effective limit, usage, the window
end and the conservative-estimate disclosure. HTTP maps a spent allowance to
429, not 500: the request was refused deliberately.

## Authorization

Reading budgets needs admitted workspace membership. Setting a ceiling or a
permission needs `installation.manage`. Consent is the workspace's own.
