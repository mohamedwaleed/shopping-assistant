// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolveLang } from "@/lib/i18n";
import { SignInForm } from "@/app/auth-forms";
import { signInAction } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lang = resolveLang(params.lang);
  return <SignInForm lang={lang} action={signInAction} />;
}
