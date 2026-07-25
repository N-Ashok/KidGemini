"use client";
// Parent-side Sparks card (PRD-SPARKS Phase 4) — mounted inside the PIN-gated
// Parent dashboard. This is where the PRECISION lives (owner decision
// 2026-07-25): exact balance, rupee value, and the full append-only statement
// including spends (with the tokens + ₹ cost behind each). Also the
// parent-only social-share submission — kids never touch social surfaces.

import { useEffect, useState } from "react";

interface Txn {
  id: string;
  at: string;
  kind: string;
  amount: number;
  balanceAfter: number;
  meta: {
    action?: string;
    gameSlug?: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    costInr?: number;
    couponCode?: string;
    note?: string;
  };
}

const KIND_LABEL: Record<string, string> = {
  usage_debit: "Building with Ari",
  signup_grant: "Welcome Sparks",
  coupon: "Coupon",
  referral_reward: "Referral reward",
  invite_reward: "Friend joined a game",
  publish_reward: "Game published",
  social_share: "Social share",
  admin_grant: "Sparks from Ariantra",
  admin_revoke: "Adjustment by Ariantra",
  purchase: "Top-up",
  refund: "Refund",
};

export function SparksParentCard() {
  const [balance, setBalance] = useState<number | null>(null);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [share, setShare] = useState({ gameSlug: "", platform: "twitter", url: "" });
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/parent/sparks");
        if (!res.ok) return;
        const data = (await res.json()) as { balance: number; transactions: Txn[] };
        setBalance(data.balance);
        setTxns(data.transactions);
      } catch {
        /* card degrades to hidden numbers; the rest of the dashboard works */
      }
    })();
  }, []);

  async function submitShare(e: React.FormEvent) {
    e.preventDefault();
    setShareMsg(null);
    const res = await fetch("/api/parent/sparks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(share),
    });
    const data = (await res.json().catch(() => ({}))) as { credited?: number; error?: string };
    if (res.ok && (data.credited ?? 0) > 0) {
      setShareMsg(`🎉 +${data.credited} ⚡ credited to your child for the ${share.platform} share!`);
      setShare({ gameSlug: "", platform: "twitter", url: "" });
    } else if (res.ok) {
      setShareMsg("That share was already counted for this game — thank you for sharing again though!");
    } else {
      setShareMsg(data.error ?? "Couldn't record the share — check the details?");
    }
  }

  const rows = expanded ? txns : txns.slice(0, 6);

  return (
    <article className="card space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">⚡ Sparks</h2>
          <p className="mt-1 text-sm text-ink-700">
            Prepaid credits your child spends building games (100 ⚡ = ₹1). Chatting is free; building
            is billed from exactly what the AI costs us — every Spark itemized below. Your child sees
            only what they earned, never a draining meter; money things come to you.
          </p>
        </div>
        {balance !== null && (
          <div className="text-right">
            <div className="text-2xl font-extrabold">{balance.toLocaleString()} ⚡</div>
            <div className="text-xs text-ink-700">= ₹{(balance / 100).toFixed(2)}</div>
          </div>
        )}
      </div>

      {/* Full statement — the append-only ledger, verbatim */}
      {txns.length > 0 && (
        <div className="divide-y divide-gray-100 border-t border-gray-200 pt-2 text-sm">
          {rows.map((t) => (
            <div key={t.id} className="flex items-start gap-3 py-2">
              <div className="min-w-0">
                <div className="font-medium">
                  {KIND_LABEL[t.kind] ?? t.kind}
                  {t.meta.gameSlug ? ` · ${t.meta.gameSlug}` : ""}
                </div>
                <div className="text-xs text-ink-700">
                  {new Date(t.at).toLocaleString()}
                  {t.meta.tokensIn != null && ` · ${(t.meta.tokensIn + (t.meta.tokensOut ?? 0)).toLocaleString()} tokens`}
                  {t.meta.costInr != null && ` · ₹${t.meta.costInr.toFixed(2)} cost`}
                  {t.meta.note ? ` · “${t.meta.note}”` : ""}
                </div>
              </div>
              <div className="ml-auto shrink-0 text-right">
                <div className={`font-bold ${t.amount > 0 ? "text-emerald-600" : ""}`}>
                  {t.amount > 0 ? "+" : ""}
                  {t.amount.toLocaleString()}
                </div>
                <div className="text-[11px] text-ink-700">{t.balanceAfter.toLocaleString()}</div>
              </div>
            </div>
          ))}
          {txns.length > 6 && (
            <button onClick={() => setExpanded(!expanded)} className="w-full py-2 text-xs font-semibold text-ink-700">
              {expanded ? "Show less" : `Show all ${txns.length} entries`}
            </button>
          )}
        </div>
      )}

      {/* Parent-only social share reward */}
      <form onSubmit={submitShare} className="space-y-2 border-t border-gray-200 pt-3">
        <div className="text-sm font-semibold">📣 Shared your child&rsquo;s game on Ariantra&rsquo;s Twitter/Instagram?</div>
        <p className="text-xs text-ink-700">
          Paste the link and they earn bonus Sparks (once per game per platform). This stays a
          parent-only action — children are never sent to social media.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={share.gameSlug}
            onChange={(e) => setShare({ ...share, gameSlug: e.target.value })}
            placeholder="game-name"
            aria-label="Game"
            className="w-32 flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          />
          <select
            value={share.platform}
            onChange={(e) => setShare({ ...share, platform: e.target.value })}
            aria-label="Platform"
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="twitter">Twitter/X</option>
            <option value="instagram">Instagram</option>
          </select>
          <input
            value={share.url}
            onChange={(e) => setShare({ ...share, url: e.target.value })}
            placeholder="https://…"
            aria-label="Share link"
            className="w-40 flex-[2] rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          />
          <button className="btn-primary" disabled={!share.gameSlug || !share.url}>
            Claim ⚡
          </button>
        </div>
        {shareMsg && <p className="text-sm">{shareMsg}</p>}
      </form>
    </article>
  );
}
