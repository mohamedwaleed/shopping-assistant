# Expiring email links for invitations, recovery and address changes

Invitations, password recovery and email-address changes all hand out one kind
of thing: an expiring, single-use link delivered over the installation's own
SMTP settings (ADR 0009, ticket 04). They share one table and one module rather
than three mechanisms.

## One table, one module

`account_link_tokens` (migration `20261119000000_invitations_and_resets`)
stores, per link: `kind` (`invitation`, `password-reset`, `email-change`), the
SHA-256 `token_hash`, the `email` the link is bound to, the `user_id` it acts on,
`expires_at` and `consumed_at`. The raw token exists only in the delivered
message: a database dump cannot be turned into a working link, and the hash is
computed with the same helper the setup token uses.

`packages/core/src/auth/account-links.ts` owns every flow. Core decides who may
ask and when; the identity library still hashes and stores passwords.

| Flow | Lifetime | Who may start it | What it does |
| --- | --- | --- | --- |
| Invitation | 7 days | installation administrator | creates the identity for the invited address and its own private workspace |
| Password reset | 30 minutes | anyone (same answer either way) | replaces the password and revokes every session |
| Email change | 30 minutes | the account, after recent authentication | switches the sign-in address once the new mailbox confirms |

## Single use is one conditional update

Consumption is a single statement: `UPDATE ... SET consumed_at = now() WHERE
token_hash = $1 AND kind = $2 AND consumed_at IS NULL AND expires_at > now()
RETURNING ...`. Of any number of concurrent consumers exactly one sees a
returned row; the others get nothing and are told the link is invalid. Expired,
already-spent, unknown and wrong-kind links are indistinguishable on purpose:
`invalid-account-link` is one answer for all of them.

Acceptance is the one flow that does other work before spending its token, so
it reads the link first, creates the identity, and only then consumes it; a
refused identity releases the link again, so a shopper can retry.

## What each flow must not leak or skip

- **Non-enumeration.** A reset request answers `202 { accepted: true }` for a
  known address, an unknown address, and a delivery that failed. Nothing about
  the account or about delivery reaches the caller, and a failed delivery leaves
  no reset token behind.
- **Session revocation.** A reset deletes every session row of the account
  before writing the new password, so a session that was already open is signed
  out even if the write then fails. The email-change confirmation revokes every
  session too, because the identity has moved.
- **Recent authentication.** `auth.changeEmail` keeps the ticket 03 gate: a
  session older than `RECENT_AUTHENTICATION_SECONDS` gets
  `reauthentication-required` and nothing is sent.
- **Unavailable email is reported, never glossed over.** Invitations and email
  changes return the mailer's own `mail-not-configured` / `mail-delivery-failed`
  contract and report no completed change. Only the reset request stays silent,
  because saying "delivery failed" there would reveal that the account exists.
- **Address changes need the new mailbox.** Nothing switches until the new
  address confirms; the confirmation is bound to that address, single-use and
  expires in thirty minutes. An address another account already uses is refused
  at the request, which is the account owner's own action and reveals nothing
  they cannot already see in the sign-in form.

## Administrator recovery is operator-only

Losing the installation administrator's password is not a browser problem. It
is recovered on the host with `pnpm admin:recover <email>`, which needs
`ADMIN_RECOVERY_TOKEN` (held in the deployment's environment, never in the
database), reads the new password from `ADMIN_NEW_PASSWORD_FILE`, only acts on
the account the setup claim recorded, and revokes that account's sessions. The
web application exposes no recovery endpoint; `POST
/api/administration/recovery` answers `404` so a caller gets an unambiguous
refusal. See `docs/runbooks/administrator-recovery.md`.

The identity library's own `/request-password-reset` route is not wired up: the
application never passes `sendResetPassword`, so that route reports reset as
disabled rather than mailing a link the installation did not ask for.
