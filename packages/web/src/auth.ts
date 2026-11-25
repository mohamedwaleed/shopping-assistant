import type { Database } from "@shopping-assistant/database";
import { betterAuth } from "better-auth";
import { createKnexAdapter } from "./adapter.ts";
import type { Mailer } from "./mailer.ts";

/** Verification links are valid for a day: long enough for a real inbox, short enough to leak little. */
const VERIFICATION_EXPIRY_SECONDS = 60 * 60 * 24;

export interface AuthConfiguration {
  database: Database;
  secret: string;
  /** The origin shoppers reach; cookies and verification links are built from it. */
  baseUrl: string;
  mailer: Mailer;
  /**
   * Installation policy that Better Auth's own options cannot express: whether
   * the installation exists yet, and whether public registration is open.
   */
  installation: () => Promise<{ bootstrapped: boolean; registrationOpen: boolean }>;
}

/**
 * Better Auth owns identities, credentials, sessions, and verification tokens.
 * The web layer owns this instance; the engine never sees a password.
 */
export function createAuth({ database, secret, baseUrl, mailer, installation }: AuthConfiguration) {
  return betterAuth({
    database: createKnexAdapter(database),
    secret,
    // Every auth route is mounted under `/api/auth`; Better Auth derives its
    // base path from this URL, so the prefix belongs to it. Verification links
    // are built from it too.
    baseURL: `${baseUrl}/api/auth`,
    trustedOrigins: [baseUrl],
    emailAndPassword: {
      enabled: true,
      // An unverified account cannot sign in; sign-up returns a generic success
      // so it cannot be used to discover which emails have accounts.
      requireEmailVerification: true,
    },
    emailVerification: {
      expiresIn: VERIFICATION_EXPIRY_SECONDS,
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      async sendVerificationEmail({ user, url }) {
        await mailer.send({
          to: user.email,
          subject: "Verify your email address",
          text: `Confirm your email address to finish signing up: ${url}`,
        });
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Public registration is installation policy, and only email/password
          // sign-up creates accounts here, so this is where the gate belongs.
          // `false` refuses the write; the sign-up endpoint then answers
          // `FAILED_TO_CREATE_USER` and no row is written. The bootstrap admin
          // is the one identity created while the installation is still open.
          async before() {
            const { bootstrapped, registrationOpen } = await installation();
            return !bootstrapped || registrationOpen;
          },
        },
      },
    },
    advanced: {
      // Cookies follow the deployment: Secure only when the origin is HTTPS.
      useSecureCookies: baseUrl.startsWith("https://"),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
