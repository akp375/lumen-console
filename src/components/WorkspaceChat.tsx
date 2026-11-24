"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AiBadge } from "./AiBadge";
import { Markdown } from "./Markdown";
import { PageHeader } from "./PageHeader";
import { Spinner } from "./Spinner";
import { PAGES } from "@/lib/pages";
import { HISTORY_MESSAGES, MAX_QUESTION_CHARS, TIMEOUT_MS } from "@/lib/workspace-limits";

// Chat for the Workspace page. The conversation lives in this page's memory
// only (no database). Each question is sent with the last HISTORY_MESSAGES
// messages so follow-ups work without resending the whole chat.

type Message = { role: "user" | "assistant"; content: string; model?: string; costUsd?: number; latencyMs?: number; error?: boolean };

const STARTERS = [
  "Which renewals are most at risk this quarter?",
  "Which open deals have no executive sponsor?",
  "Which 5 accounts have the worst margin, and why?",
  "What's our NRR and what's driving it?",
];


export function WorkspaceChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null); // a guardrail was hit: shown above the input, not as an error
  const chatId = useRef(0); // bumps on "New chat" so a late answer from the old chat is dropped
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, waiting]);

  const send = async (question: string) => {
    const text = question.trim();
    if (!text || waiting) return;
    if (text.length > MAX_QUESTION_CHARS) {
      setNotice(`Questions are limited to ${MAX_QUESTION_CHARS.toLocaleString("en-US")} characters. Please shorten yours.`);
      return;
    }
    const id = chatId.current;
    setNotice(null);
    // Only successful turns go to the server; a failed answer and its question are left out.
    const history: Message[] = [];
    for (let k = 0; k < messages.length; k++) {
      const m = messages[k];
      if (m.role === "user" && messages[k + 1] && !messages[k + 1].error) history.push(m, messages[k + 1]);
    }
    const recent = history.slice(-HISTORY_MESSAGES);
    const next: Message[] = [...messages, { role: "user", content: text }];
    // A limit notice puts the question back in the box and drops it from the chat.
    const showNotice = (message: string) => {
      setMessages(messages);
      setDraft(text);
      setNotice(message);
    };
    setMessages(next);
    setDraft("");
    setWaiting(true);
    // Safety net in case the server never answers; the server stops Claude at TIMEOUT_MS itself.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS + 10_000);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...recent, { role: "user", content: text }].map(({ role, content }) => ({ role, content })) }),
        signal: abort.signal,
      });
      const data = (await res.json()) as { text?: string; model?: string; costUsd?: number; latencyMs?: number; error?: string; notice?: string };
      if (id !== chatId.current) return;
      if (data.notice) return showNotice(data.notice);
      setMessages([
        ...next,
        res.ok && data.text
          ? { role: "assistant", content: data.text, model: data.model, costUsd: data.costUsd, latencyMs: data.latencyMs }
          : { role: "assistant", content: data.error ?? "Something went wrong.", error: true },
      ]);
    } catch (e) {
      if (id !== chatId.current) return;
      if (abort.signal.aborted) return showNotice("That took too long, so it was stopped. Try a shorter or more specific question.");
      setMessages([...next, { role: "assistant", content: e instanceof Error ? e.message : "Network error.", error: true }]);
    } finally {
      clearTimeout(timer);
      if (id === chatId.current) setWaiting(false);
    }
  };

  const newChat = () => {
    chatId.current++;
    setMessages([]);
    setDraft("");
    setNotice(null);
    setWaiting(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={PAGES.workspace.title}
        description={PAGES.workspace.description}
        actions={
          <button
            type="button"
            onClick={newChat}
            disabled={messages.length === 0 && !draft}
            className="rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            New chat
          </button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950" aria-live="polite">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Try one of these to start:</p>
            <div className="grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
              {STARTERS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => void send(q)}
                  className="rounded-lg border border-zinc-200 px-4 py-3 text-left text-sm text-zinc-700 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-900"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((m, k) =>
              m.role === "user" ? (
                <div key={k} className="flex justify-end">
                  <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={k} className="flex justify-start">
                  <div className="max-w-[85%]">
                    <div
                      className={`rounded-2xl rounded-bl-sm px-4 py-3 text-sm ${
                        m.error
                          ? "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
                          : "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                      }`}
                    >
                      {m.error ? m.content : <Markdown text={m.content} />}
                    </div>
                    {m.costUsd !== undefined && m.latencyMs !== undefined && (
                      <p className="mt-1 flex items-center gap-2 pl-2 text-xs text-zinc-400">
                        <AiBadge model={m.model ?? null} costUsd={m.costUsd} />
                        {(m.latencyMs / 1000).toFixed(1)} s
                      </p>
                    )}
                  </div>
                </div>
              ),
            )}
            {waiting && (
              <div className="flex justify-start">
                <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-sm bg-zinc-100 px-4 py-2 text-sm text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <Spinner className="h-3.5 w-3.5" />
                  Thinking...
                </div>
              </div>
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>

      {notice && (
        <div role="status" className="mt-3 flex items-start justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice" className="shrink-0 text-amber-700 hover:text-amber-900 dark:text-amber-300">
            ✕
          </button>
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-3 flex items-end gap-2">
        <div className="relative flex-1">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            maxLength={MAX_QUESTION_CHARS}
            placeholder="Ask a question… (Enter to send, Shift+Enter for a new line)"
            aria-label="Your question"
            className="block min-h-[3rem] w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 pr-20 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          {draft.length > MAX_QUESTION_CHARS * 0.8 && (
            <span className="pointer-events-none absolute bottom-2 right-3 text-xs tabular-nums text-zinc-400">
              {draft.length.toLocaleString("en-US")} / {MAX_QUESTION_CHARS.toLocaleString("en-US")}
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={waiting || !draft.trim()}
          aria-busy={waiting}
          className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-3 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {waiting && <Spinner />}
          Send
        </button>
      </form>
    </div>
  );
}
