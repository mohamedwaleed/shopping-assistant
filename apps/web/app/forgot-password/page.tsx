// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolveLang } from "@/lib/i18n";
import { ForgotPasswordForm } from "@/app/auth-forms";
import { requestPasswordResetAction } from "@/app/actions";

export const dynamic = "force-dynamic";

/**
 * Ask for a reset link. The screen answers the same for a known address, an
 * unknown address and an email failure, so it cannot be used to discover which
 * accounts exist on this installation.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lang = resolveLang(params.lang);
  return <ForgotPasswordForm lang={lang} action={requestPasswordResetAction} />;
}
