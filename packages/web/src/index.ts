export { createAuth, type Auth, type AuthConfiguration } from "./auth.ts";
export { createAuthServer } from "./auth-http.ts";
export { createPasswordSetter, markEmailVerified } from "./account-links.ts";
export { createIdentityStore, currentUser, type AuthenticatedUser } from "./identity.ts";
export { createKnexAdapter } from "./adapter.ts";
export {
  createRecordingMailer,
  createSmtpMailer,
  type Mailer,
  type OutgoingEmail,
} from "./mailer.ts";
