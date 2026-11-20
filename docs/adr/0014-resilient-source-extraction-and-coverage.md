# Read sources through maintained adapters and record their coverage

A permitted product page is read by a maintained source adapter when the
retailer has one, by its schema.org data when it publishes any, and otherwise
by readable content plus one bounded, schema-constrained model call. The source
adapter registry is code, not configuration: `packages/core/src/ingestion/source-adapters.ts`
declares each adapter with an `id`, a `version`, the exact hosts it was written
for, and the required fields it must find. Adding a retailer means adding an
adapter and a reviewed fixture — never widening a generic pattern to catch every
site, which would be the universal-retailer claim this project does not make.

## Required fields are never guessed

`REQUIRED_PRODUCT_FIELDS` is `name`, `price`, `currency` and `gtin`. Every
reading reports `requiredCoverage: { present, missing }`, and a missing required
field stays missing:

- A maintained adapter reports what its layout gave up rather than filling it.
- A model reading is accepted only where the readable line the model cited
  actually states the value (`verifyModelReading`). A price the page never
  states, or a currency with no evidence, is dropped. GTINs must be 8, 12, 13 or
  14 digits; a currency must be ISO-4217 shaped; a price must be a plain decimal
  string. Nothing is coerced into shape.
- A maintained adapter is authoritative for its host: if it cannot find a
  required field, the model is not asked to fill the gap.

Readable content keeps the page region each line came from
(`readableContent`), which is what makes the evidence link checkable rather than
decorative. Extraction is one call of 512 output tokens with SDK retries
disabled (docs/adr/0012); the model role is the installation's extraction
override, then its default, on the installation credential — catalogue reading
belongs to no workspace, so a workspace key is never borrowed.

## Coordination, deduplication and cache context

`packages/core/src/ingestion/source-reader.ts` owns what happens around a
retrieval; the retrieval bounds themselves (URL safety, destinations, redirects,
size, time) stay in the ingestion fetch helper.

- **Per host:** `source_host_policies` holds `max_concurrent` (1–8) and
  `minimum_interval_ms` (0–60000), defaulting to one slot and one second. Slot
  assignment runs inside a transaction holding an advisory lock, and the
  reservation is inserted in the same transaction, so a worker that waited out
  the interval cannot find its slot taken and start a second interval.
- **Deduplication:** `source_requests` is keyed by URL. A request in the same
  cache context that is still in flight is awaited; a completed read inside its
  window is replayed from the evidence row it produced. The wait for a slot and
  for another worker is bounded (`HOST_SLOT_WAIT_MS`), after which the caller
  gets `host-busy` rather than hanging.
- **Cache context:** the key is `scope#revision`. A page read under one
  extraction revision is never served to another, and a different context retires
  the old row instead of reusing it.
- **Retry-After and backoff:** `Retry-After` (seconds or HTTP-date) is honoured
  but clamped to `MAX_RETRY_AFTER_MS` (15 minutes). An absent header means the
  source stated no window, so the block does not apply to later requests.

## Access blocks are recorded, never evaded

A 429, a 503, a 403, or an HTTP-200 challenge page is recorded in
`source_access_blocks` with the signal that identified it, and reads of that host
stop until the Retry-After passes. A robots or terms restriction
(`sources.recordAccessBlock`) has no expiry because only a person can withdraw
it, and only an installation administrator may record one. No browser automation
is involved, and nothing here attempts to defeat a challenge.

## Coverage is recorded beside observations, not instead of them

`sources.coverage(principal, host)` reports the adapter id and version, the
required fields covered and missing, the last success and last failure, the fetch
time, the source's own cache expiry and this installation's reuse expiry, the
recorded access blocks, and the evidence and claim count the last good read
produced. A layout change records a failure and lowers coverage; it never deletes
a price observation or a claim. Coverage is written after the observation
transaction commits, so a coverage write cannot roll back a good observation.

## Evidence

`packages/core/test/support/source-fixtures.ts` holds reviewed Coolblue and bol
pages, each paired with a "after the redesign" page for the same offer, so a test
proves that a redesign yields partial coverage and leaves the last good
observation intact. Those fixtures are deterministic proof, not live proof. The
cross-category live pilot (`packages/core/test/live-pilot.test.ts`) runs only
when `LIVE_PILOT=1` with an operator identity supplied, asserts only that the
source was read and its coverage is complete or honestly partial, and never
asserts a price.
