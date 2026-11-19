// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";
import { requestIdentity } from "@/lib/auth/session";
import { dictionaries, resolveLang } from "@/lib/i18n";
import { ChatClient } from "./chat-client";
export default async function ChatPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) { const lang = resolveLang((await searchParams).lang); if (!await requestIdentity()) redirect(`/sign-in?lang=${lang}`); return <main className="content" lang={lang}><div className="topbar"><h1>{dictionaries[lang].navChat}</h1><a className="lang-switch" href={`/chat?lang=${lang === "en" ? "nl" : "en"}`}>{dictionaries[lang].languageSwitch}</a></div><ChatClient language={lang} /></main>; }
