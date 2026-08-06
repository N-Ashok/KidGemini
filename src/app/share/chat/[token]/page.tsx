// Public read-only transcript at a secret link (2026-08-06_PRD_
// ShareConversation.md). The ONLY unauthenticated view of a conversation:
// token-only lookup, dead the moment the link is revoked or the chat deleted.
// TEXT-ONLY by design — artifactHtml (model-generated game code) is NEVER
// rendered here; games show as a chip. noindex: a secret link must never
// reach a search engine.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SqliteChatHistoryStore } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const store = new SqliteChatHistoryStore();

interface Params {
  params: { token: string };
}

export function generateMetadata({ params }: Params): Metadata {
  const shared = store.getSharedByToken(params.token);
  return {
    title: shared ? `${shared.title} — a chat with Ari` : "Shared chat — Ariantra",
    robots: { index: false, follow: false },
  };
}

export default function SharedChatPage({ params }: Params) {
  const shared = store.getSharedByToken(params.token);
  if (!shared) notFound();

  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-white px-4 py-8 text-neutral-900">
      <header className="mb-6 text-center">
        <div className="text-4xl">✨</div>
        <h1 className="font-display mt-1 text-2xl font-bold">{shared.title}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          A chat with Ari, shared by its creator · {new Date(shared.updatedAt).toLocaleDateString()}
        </p>
      </header>

      <ol className="space-y-3">
        {shared.messages.map((m) => (
          <li key={m.id} className={m.role === "child" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                m.role === "child"
                  ? "max-w-[85%] rounded-2xl rounded-br-md bg-orange-100 px-4 py-2.5 text-sm"
                  : "max-w-[85%] rounded-2xl rounded-bl-md bg-neutral-100 px-4 py-2.5 text-sm"
              }
            >
              {m.text && <p className="whitespace-pre-wrap">{m.text}</p>}
              {m.artifactHtml && (
                <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-white/70 px-2.5 py-1 text-xs font-bold text-orange-600">
                  🎮 built a game here
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>

      <footer className="mt-10 border-t border-neutral-200 pt-4 text-center text-sm text-neutral-500">
        <p>
          Made with{" "}
          <a href="/" className="font-bold text-orange-600 underline">
            Ari — the Ariantra Games-Lab
          </a>
          , where kids build real games by chatting.
        </p>
      </footer>
    </main>
  );
}
