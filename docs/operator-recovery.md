# Operator-only administrator recovery

There is deliberately no public administrator-password override. If the only
installation administrator loses access, the self-hosting operator must use
their protected PostgreSQL backup/restore and deployment-secret procedure to
recover the installation, then issue a normal email recovery link through the
configured SMTP service. Database access is an operator-only break-glass
procedure, outside the application HTTP surface; record the action, rotate
affected secrets and revoke browser sessions afterwards.

This separation avoids turning a public endpoint into a bypass for the
administrator's password, email-link expiry, or future second factor.
