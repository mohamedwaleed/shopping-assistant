# Recovering the installation administrator

Use this when the installation administrator cannot sign in: the password is
lost and their mailbox is unreachable, so the normal reset link cannot help.
This is a host operation, performed by whoever operates the deployment. There is
no web page and no API for it (ADR 0013): the web application answers `404` on
`/api/administration/recovery`, so nothing reachable from a browser can override
a password.

## What you need

- Shell access to the host that serves the installation.
- The deployment's environment, in particular `DATABASE_URL`,
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and a recovery token:
  - `ADMIN_RECOVERY_TOKEN`: any long random value you keep with the deployment's
    secrets, for example `openssl rand -base64 48`. Without it the command
    refuses, so recovery is off unless the operator turned it on.
- The administrator's sign-in address.
- A file containing the new password (at least 10 characters), readable only by
  you. The command reads it from `ADMIN_NEW_PASSWORD_FILE`, never from the
  command line, and removes it after a successful recovery.

## Steps

1. Write the new password to a private file:

   ```sh
   umask 077
   openssl rand -base64 24 > /tmp/admin-password.txt   # or type your own
   ```

2. Run the command from the repository, with the deployment's environment:

   ```sh
   ADMIN_RECOVERY_TOKEN='<the token held with the deployment secrets>' \
   ADMIN_NEW_PASSWORD_FILE=/tmp/admin-password.txt \
   pnpm admin:recover operator@example.nl
   ```

   A successful run prints `recovered operator@example.nl: password replaced, N
   sessions revoked` and deletes the password file.

3. Sign in with the new password, then change it from **Account** if someone
   else chose it.

## What it refuses, and why

| Output | Meaning |
| --- | --- |
| `ADMIN_RECOVERY_TOKEN is not set` | Recovery is not enabled for this deployment. |
| `invalid-recovery-token` | The token does not match the deployment's. |
| `unknown-address` | No account has that address. |
| `not-the-administrator` | That account is not the installation administrator recorded by the setup claim. Routine shoppers recover with the normal reset link. |
| `the new password must be at least 10 characters` | The password file is too short; nothing changed. |

Every refusal leaves the stored password and the sessions untouched. A
successful recovery revokes every session of that account, so anyone holding the
old password is signed out everywhere.

## After recovery

- Delete the recovery token from the deployment's environment if you do not want
  to keep this door open; setting it again later is enough to re-enable.
- If the administrator's mailbox is reachable after all, prefer the ordinary
  reset link: it needs no host access.
