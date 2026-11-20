// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";
import { useEffect, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import type { ChatGPTPlanView } from "@shopping/core";
import { dictionaries, type Lang } from "@/lib/i18n";

type Session = { id: string; title: string; language: "en" | "nl" };

/**
 * Which account pays for this turn is shown before the shopper sends anything,
 * so a paused plan or an API-key fallback is never a surprise. The plan turn
 * answers with a bounded JSON report (the plan route streams only), so its
 * outcome is appended to the transcript as a message.
 */
export function ChatClient({ language }: { language: "en" | "nl" }) {
  const t = dictionaries[language as Lang];
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [input, setInput] = useState("");
  const [plan, setPlan] = useState<ChatGPTPlanView | null>(null);
  const [planNotice, setPlanNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const existing = await fetch("/api/chat/sessions").then((r) => (r.ok ? (r.json() as Promise<Session[]>) : []));
      if (existing[0]) {
        setSessions(existing);
        setSessionId(existing[0].id);
        return;
      }
      const created = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: language === "nl" ? "Nieuwe shopping sessie" : "New shopping session", language }),
      }).then((r) => r.json() as Promise<{ id: string; title: string; language: "en" | "nl" }>);
      setSessions([created]);
      setSessionId(created.id);
    })();
  }, [language]);

  useEffect(() => {
    void fetch("/api/settings/chatgpt-plan")
      .then((response) => (response.ok ? (response.json() as Promise<ChatGPTPlanView>) : null))
      .then((view) => {
        if (!view) return;
        setPlan(view);
        if (view.usageSource === "chatgpt-plan" && view.plan.state === "paused") {
          setPlanNotice(view.plan.reason === "usage-limit" ? t.planReasonUsageLimit : t.planReasonUnavailable);
        }
      });
  }, [t]);

  const { messages, sendMessage, setMessages, status, error, stop } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat", body: () => ({ sessionId }) }),
  });

  useEffect(() => {
    if (!sessionId) return;
    void fetch(`/api/chat/sessions/${sessionId}`)
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ messages: Array<{ id: string; role: "user" | "assistant" | "tool"; content: string }> }>)
          : null,
      )
      .then((session) => {
        if (session)
          setMessages(
            session.messages
              .filter((message): message is { id: string; role: "user" | "assistant"; content: string } => message.role !== "tool")
              .map((message): UIMessage => ({ id: message.id, role: message.role, parts: [{ type: "text", text: message.content }] })),
          );
      });
  }, [sessionId, setMessages]);

  async function send() {
    if (!input.trim() || !sessionId) return;
    const text = input;
    setInput("");
    setPlanNotice(null);
    sendMessage({ text });
  }

  const paying =
    plan?.usageSource === "chatgpt-plan" ? t.planUsageSourcePlan : t.planUsageSourceKey;

  return (
    <div className="chat-layout">
      <aside className="session-list">
        <strong>{language === "nl" ? "Sessies" : "Sessions"}</strong>
        {sessions.map((session) => (
          <button
            className={session.id === sessionId ? "session active" : "session"}
            key={session.id}
            onClick={() => setSessionId(session.id)}
          >
            {session.title}
          </button>
        ))}
      </aside>
      <section className="panel chat-panel">
        <p className="hint">
          {t.planUsageSourceLabel}: <strong>{paying}</strong>
          {plan?.usageSource === "chatgpt-plan" && plan.plan.state === "paused" && ` · ${t.planQuotaPaused}`}
        </p>
        {planNotice && (
          <p className="notice notice-error" role="alert">
            {planNotice}{" "}
            <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">
              {t.planManageUsage}
            </a>
          </p>
        )}
        <div className="chat-messages" aria-live="polite">
          {messages.map((message) => (
            <article key={message.id} className={`chat-message ${message.role}`}>
              <strong>{message.role === "user" ? (language === "nl" ? "Jij" : "You") : "Assistant"}</strong>
              {message.parts.map((part, index) =>
                part.type === "text" ? (
                  <p key={index}>{part.text}</p>
                ) : part.type.startsWith("tool-") ? (
                  <p className="tool-state" key={index}>
                    {language === "nl" ? "Vereisten bijgewerkt" : "Requirements updated"}
                  </p>
                ) : null,
              )}
            </article>
          ))}
        </div>
        {error && (
          <p className="notice notice-error" role="alert">
            {error.message}
          </p>
        )}
        <form
          className="chat-form"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor="chat-input">{language === "nl" ? "Beschrijf wat je zoekt" : "Describe what you need"}</label>
          <textarea
            id="chat-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={!sessionId || status === "streaming"}
          />
          <div>
            <button className="btn-primary" type="submit" disabled={!sessionId || !input.trim()}>
              {language === "nl" ? "Versturen" : "Send"}
            </button>
            {status === "streaming" && (
              <button className="btn-quiet" type="button" onClick={stop}>
                {language === "nl" ? "Stoppen" : "Stop"}
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
