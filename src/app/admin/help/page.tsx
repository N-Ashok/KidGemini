"use client";
// 🆘 Help queue — the operator surface for Community Help Phase 1
// (docs/PRD-COMMUNITY-HELP.md §3.7). Sibling of /admin (usage): same
// ADMIN_SECRET-in-a-POST-body gate, same single-page shape, no new credential.
//
// Design decisions that are load-bearing rather than cosmetic:
//  · OLDEST FIRST, and waiting time colour-coded against the 16h reply target
//    (help-sla.ts) — a newest-first queue is how the ticket that waited all
//    night gets buried.
//  · Canned replies are the primary action; free text is a second, visibly
//    marked step, because free text is the exception that needs review.
//  · "Load game source" is its own button and writes an audit row server-side.
//    Never fetched with the ticket (PRD §3.4).

import { useState } from "react";
import type { HelpReasonCode, HelpReply } from "@/types/help.types";
import type { TicketAgeState } from "@/lib/help-sla";

interface CannedOption {
  id: string;
  label: string;
  body: string;
}

interface QueueTicket {
  id: string;
  accountId: string;
  isGuest: boolean;
  reasonCode: HelpReasonCode;
  transcript: string | null;
  errorReport: string | null;
  verifyVerdict: string | null;
  conversationId: string | null;
  messageId: string | null;
  status: "open" | "answered" | "closed";
  createdAt: number;
  updatedAt: number;
  ageState: TicketAgeState;
  waitingLabel: string;
  replies: HelpReply[];
  canned: CannedOption[];
}

type Scope = "open" | "answered" | "all";

const REASON_LABEL: Record<HelpReasonCode, string> = {
  wont_move: "🕹️ It won't move",
  blank: "⬜ Screen is blank",
  looks_wrong: "🎨 It looks wrong",
  no_sound: "🔇 No sound",
  dont_know: "🤷 Doesn't know what to ask",
  other: "🎤 Something else",
};

/** Quiet under 8h, amber past 8h, red past the 16h promise. */
const AGE_STYLE: Record<TicketAgeState, string> = {
  fresh: "bg-neutral-100 text-neutral-600",
  due: "bg-warn-50 text-warn-600",
  overdue: "bg-red-50 text-danger-600 font-extrabold",
};

export default function HelpQueuePage() {
  const [secret, setSecret] = useState("");
  const [scope, setScope] = useState<Scope>("open");
  const [tickets, setTickets] = useState<QueueTicket[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [source, setSource] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");

  async function call(payload: Record<string, unknown>) {
    const res = await fetch("/api/admin/help", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, ...payload }),
    });
    return { res, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function load(nextScope: Scope = scope, e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    const { res, body } = await call({ action: "list", scope: nextScope });
    setBusy(false);
    if (!res.ok) {
      setError(
        res.status === 503
          ? "ADMIN_SECRET isn't configured on the server — the queue is offline."
          : "Wrong admin secret.",
      );
      return;
    }
    setScope(nextScope);
    setTickets((body.tickets as QueueTicket[]) ?? []);
  }

  async function sendReply(ticket: QueueTicket, payload: { cannedId?: string; body?: string }) {
    setBusy(true);
    setNotice("");
    const { res, body } = await call({ action: "reply", ticketId: ticket.id, ...payload });
    setBusy(false);
    if (!res.ok) {
      // Every failure says what to do next (CLAUDE.md §9) — these are the real
      // server refusals, not generic errors.
      const why =
        body.error === "canned_only_for_guests"
          ? "This ticket came from a guest device, so there's no parent to mirror a hand-written reply to. Send a canned reply instead."
          : body.error === "reply_blocked"
            ? `Blocked before sending: ${String(body.reason ?? "the wording tripped a safety rule")}. Rephrase without contact details or strong words.`
            : body.error === "too_long"
              ? "Too long for a kid to read — trim it to a couple of sentences."
              : body.error === "canned_reason_mismatch"
                ? "That canned reply belongs to a different reason. Pick one from this ticket's list."
                : "Couldn't send that reply. Reload the queue and try again.";
      setError(why);
      return;
    }
    setError("");
    setNotice("Reply sent — the parent's alerts list has a copy.");
    setFreeText((f) => ({ ...f, [ticket.id]: "" }));
    void load();
  }

  async function loadSource(ticket: QueueTicket) {
    setBusy(true);
    const { res, body } = await call({ action: "source", ticketId: ticket.id });
    setBusy(false);
    if (!res.ok) {
      setError("No game source stored for this ticket (the chat may have been deleted). The audit row was still written.");
      return;
    }
    setError("");
    setSource((s) => ({ ...s, [ticket.id]: String(body.artifactHtml ?? "") }));
  }

  if (!tickets) {
    return (
      <main className="mx-auto max-w-sm p-8">
        <h1 className="mb-4 font-display text-2xl font-bold">🆘 Help queue</h1>
        <form onSubmit={(e) => void load("open", e)} className="card space-y-4">
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Admin secret"
            className="w-full rounded-kid border-2 border-brand-100 px-4 py-3 text-lg"
          />
          {error && <p className="text-danger-600">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "Opening…" : "Open queue"}
          </button>
        </form>
      </main>
    );
  }

  const overdue = tickets.filter((t) => t.ageState === "overdue").length;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-3xl font-bold">🆘 Help queue</h1>
        <span className="rounded-full bg-neutral-100 px-3 py-1 text-sm font-bold text-neutral-600">
          {tickets.length} {scope === "open" ? "waiting" : scope}
        </span>
        {overdue > 0 && (
          <span className="rounded-full bg-red-50 px-3 py-1 text-sm font-extrabold text-danger-600">
            {overdue} past the 16h promise
          </span>
        )}
        <span className="ml-auto flex gap-2">
          {(["open", "answered", "all"] as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void load(s)}
              className={`rounded-full px-4 py-2 text-sm font-bold ${
                scope === s ? "bg-neutral-800 text-white" : "bg-neutral-100 text-neutral-700"
              }`}
            >
              {s}
            </button>
          ))}
        </span>
      </div>

      <p className="text-sm text-neutral-500">
        Oldest first — the longest wait is on top. A child was promised an answer <b>by tomorrow</b>, so
        anything red has broken that promise. Nothing auto-answers: if the queue outgrows one person, raise
        the nudge thresholds in <code className="rounded bg-neutral-100 px-1">src/lib/stuck-signal.ts</code>.
      </p>

      {error && <p className="rounded-kid bg-red-50 px-4 py-3 text-danger-600">{error}</p>}
      {notice && <p className="rounded-kid bg-brand-50 px-4 py-3 font-bold text-brand-700">{notice}</p>}

      {tickets.length === 0 && (
        <div className="card text-center text-neutral-500">
          Nothing waiting. 🎉 Kids are either unstuck or haven&apos;t found the 🆘 tab — check that
          NEXT_PUBLIC_ENABLE_HELP_BUTTON is on if you expected traffic.
        </div>
      )}

      <ul className="space-y-3">
        {tickets.map((t) => {
          const isOpen = openId === t.id;
          return (
            <li key={t.id} className="card space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-neutral-100 px-3 py-1 text-sm font-bold text-neutral-800">
                  {REASON_LABEL[t.reasonCode]}
                </span>
                <span className={`rounded-full px-3 py-1 text-sm tabular-nums ${AGE_STYLE[t.ageState]}`}>
                  {t.waitingLabel}
                </span>
                {t.verifyVerdict && (
                  <span className="font-mono text-xs text-neutral-500">{t.verifyVerdict}</span>
                )}
                {t.isGuest && (
                  <span className="rounded-full bg-warn-50 px-2 py-0.5 text-xs font-bold text-warn-600">
                    guest · canned replies only
                  </span>
                )}
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-bold text-neutral-600">
                  {t.status}
                </span>
                <button
                  type="button"
                  onClick={() => setOpenId(isOpen ? null : t.id)}
                  className="ml-auto rounded-full bg-neutral-100 px-4 py-2 text-sm font-bold text-neutral-700"
                >
                  {isOpen ? "Close" : "Answer"}
                </button>
              </div>

              {t.transcript && (
                <p className="rounded-kid bg-brand-50 px-3 py-2 text-sm text-neutral-800">
                  <b>They said:</b> {t.transcript}
                </p>
              )}

              {t.replies.length > 0 && (
                <ul className="space-y-1 border-l-4 border-neutral-200 pl-3">
                  {t.replies.map((r) => (
                    <li key={r.id} className="text-sm text-neutral-600">
                      {r.cannedId ? "📋" : "✍️"} {r.body}
                    </li>
                  ))}
                </ul>
              )}

              {isOpen && (
                <div className="space-y-3 border-t border-neutral-200 pt-3">
                  {t.errorReport && (
                    <details>
                      <summary className="cursor-pointer text-sm font-bold text-neutral-700">
                        Error report
                      </summary>
                      <pre className="mt-2 overflow-x-auto rounded-xl bg-neutral-900 p-3 text-xs text-neutral-100">
                        {t.errorReport}
                      </pre>
                    </details>
                  )}

                  <div className="space-y-2">
                    <p className="text-xs font-extrabold uppercase tracking-wide text-neutral-400">
                      Canned replies · reviewed, no approval needed
                    </p>
                    {t.canned.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        disabled={busy}
                        onClick={() => void sendReply(t, { cannedId: c.id })}
                        className="block w-full rounded-kid border-2 border-brand-100 px-3 py-2 text-left text-sm hover:bg-brand-50 disabled:opacity-50"
                      >
                        <b className="text-neutral-800">{c.label}</b>
                        <span className="block text-neutral-600">{c.body}</span>
                      </button>
                    ))}
                  </div>

                  {/* Guest tickets are canned-only (no parent account to mirror
                      a hand-written reply to), so don't render a box that can
                      only ever be refused — say why instead. */}
                  {t.isGuest ? (
                    <p className="rounded-kid bg-warn-50 px-3 py-2 text-xs font-bold text-warn-600">
                      ✍️ Hand-written replies are off for this ticket: it came from a guest device, so
                      there&apos;s no parent account to mirror the reply to. Send a canned reply above.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs font-extrabold uppercase tracking-wide text-warn-600">
                        ✍️ Free text · the exception — screened, and mirrored to the parent
                      </p>
                      <textarea
                        value={freeText[t.id] ?? ""}
                        onChange={(e) => setFreeText((f) => ({ ...f, [t.id]: e.target.value }))}
                        rows={3}
                        placeholder="Write in a helper's voice. No contact details, no time promises."
                        className="w-full rounded-kid border-2 border-neutral-200 px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        disabled={busy || !(freeText[t.id] ?? "").trim()}
                        onClick={() => void sendReply(t, { body: freeText[t.id] })}
                        className="rounded-full bg-neutral-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
                      >
                        Send hand-written reply
                      </button>
                    </div>
                  )}

                  <div className="space-y-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void loadSource(t)}
                      className="rounded-full bg-neutral-100 px-4 py-2 text-sm font-bold text-neutral-700"
                    >
                      Load game source
                    </button>
                    <p className="text-xs text-warn-600">
                      Separate action on purpose: it writes an audit row and is never fetched with the ticket.
                    </p>
                    {source[t.id] && (
                      <pre className="max-h-64 overflow-auto rounded-xl bg-neutral-900 p-3 text-xs text-neutral-100">
                        {source[t.id]}
                      </pre>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
