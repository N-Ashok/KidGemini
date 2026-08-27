"use client";
// Kid-facing Sparks wallet (PRD-SPARKS Phase 4; design locked from mock v2,
// 2026-07-25): trophies not a meter. Shows only up-numbers (games built,
// ⚡ earned, friends joined) + credits history + referral code + coupon
// entry. The gauge is quiet when healthy and becomes a gentle nudge when the
// platform says 'low' — never a countdown, never rupees, never deductions.
// Signed-out kids get a friendly sign-in prompt (Sparks live on the account).
//
// 2026-08-27 (owner decision, docs/2026-08-27_PRD_SparksPage.md): this page
// ALSO shows the money side now — ⚡ available / used / added, what each chat
// used, and (tap a chat) what each request cost. Everyone sees it; whole
// Sparks; the chat window itself stays free of Sparks numbers.

import { useEffect, useState } from "react";
import { signIn } from "@/lib/useAriantraSession";
import { formatSparks } from "@/lib/sparks-display";

interface UsageChat { id: string; title: string; updatedAt: number; sparks: number }
interface UsageData { balance: number | null; used: number | null; added: number | null; chats: UsageChat[] }
interface UsageAsk { ask: string; sparks: number | null; at: number }

interface EarnedRow {
  id: string;
  at: string;
  kind: string;
  amount: number;
  note?: string;
  gameSlug?: string;
}

interface WalletData {
  gauge: "good" | "low";
  earnedTotal: number;
  gamesBuilt: number;
  friendsJoined: number;
  earned: EarnedRow[];
  referralCode: string;
}

const KIND_ICON: Record<string, string> = {
  signup_grant: "👋",
  coupon: "🎁",
  referral_reward: "🏆",
  invite_reward: "🎮",
  publish_reward: "🚀",
  social_share: "📣",
  admin_grant: "💌",
  purchase: "⚡",
  refund: "↩️",
};

export function WalletPanel() {
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "signedout" | "error">("loading");
  const [coupon, setCoupon] = useState("");
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Money side (PRD_SparksPage §3): null = loading; usageError = the platform
  // or our store hiccupped — the rest of the page still works.
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [openChat, setOpenChat] = useState<string | null>(null);
  const [asks, setAsks] = useState<Record<string, UsageAsk[] | "loading" | "error">>({});

  async function loadUsage() {
    try {
      const res = await fetch("/api/sparks/usage");
      if (!res.ok) return setUsageError(true);
      setUsage((await res.json()) as UsageData);
    } catch {
      setUsageError(true);
    }
  }
  async function toggleChat(id: string) {
    if (openChat === id) return setOpenChat(null);
    setOpenChat(id);
    if (asks[id]) return;
    setAsks((a) => ({ ...a, [id]: "loading" }));
    try {
      const res = await fetch(`/api/sparks/usage?chat=${encodeURIComponent(id)}`);
      const d = res.ok ? ((await res.json()) as { asks: UsageAsk[] }) : null;
      setAsks((a) => ({ ...a, [id]: d ? d.asks : "error" }));
    } catch {
      setAsks((a) => ({ ...a, [id]: "error" }));
    }
  }

  async function load() {
    try {
      const res = await fetch("/api/wallet");
      if (res.status === 401) return setState("signedout");
      if (!res.ok) return setState("error");
      setWallet((await res.json()) as WalletData);
      setState("ready");
    } catch {
      setState("error");
    }
  }
  useEffect(() => {
    void load();
    void loadUsage();
  }, []);

  async function redeem() {
    const code = coupon.trim();
    if (!code) return;
    setCouponMsg(null);
    const res = await fetch("/api/wallet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = (await res.json().catch(() => ({}))) as { credited?: number; error?: string };
    if (res.ok && (data.credited ?? 0) > 0) {
      setCouponMsg(`🎉 +${data.credited} ⚡ added!`);
      setCoupon("");
      void load();
      void loadUsage();
    } else {
      setCouponMsg(data.error ?? "That code didn't work — check the spelling?");
    }
  }

  async function copyInvite() {
    if (!wallet) return;
    const url = `${window.location.origin}/?invite=${wallet.referralCode}`;
    try {
      await navigator.clipboard.writeText(`Come build games with me on Ariantra! ${url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the code is visible to copy by hand */
    }
  }

  if (state === "loading") {
    return (
      <main className="ar-app-main mx-auto w-full max-w-md px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-24 rounded-2xl bg-gray-200" />
          <div className="h-40 rounded-2xl bg-gray-200" />
          <div className="h-40 rounded-2xl bg-gray-200" />
        </div>
      </main>
    );
  }

  if (state === "signedout") {
    return (
      <main className="ar-app-main mx-auto w-full max-w-md px-4 py-12 text-center">
        <div className="text-5xl">⚡</div>
        <h1 className="mt-3 text-xl font-extrabold">Sparks live on your account</h1>
        <p className="mt-2 text-sm text-gray-600">Sign in to see the games you built and the Sparks you earned!</p>
        <button
          onClick={() => signIn()}
          className="mt-5 rounded-xl bg-[var(--ar-accent,#ff5c00)] px-6 py-3 font-bold text-white"
        >
          Sign in
        </button>
      </main>
    );
  }

  if (state === "error" || !wallet) {
    return (
      <main className="ar-app-main mx-auto w-full max-w-md px-4 py-12 text-center">
        <div className="text-4xl">😴</div>
        <p className="mt-3 text-sm text-gray-600">
          The Sparks page is napping — try again in a moment, or keep building in{" "}
          <a href="/" className="font-bold text-[var(--ar-accent,#ff5c00)]">Chat</a>!
        </p>
      </main>
    );
  }

  return (
    <main className="ar-app-main mx-auto w-full max-w-md px-4 py-6">
      <h1 className="sr-only">My Sparks</h1>

      {/* Your Sparks — available / used / added (PRD_SparksPage §4) */}
      <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500">Your Sparks</h2>
      {usage === null && !usageError ? (
        <div className="mt-2 grid animate-pulse grid-cols-3 gap-3" aria-label="Loading your Sparks">
          <div className="h-20 rounded-2xl bg-gray-200" />
          <div className="h-20 rounded-2xl bg-gray-200" />
          <div className="h-20 rounded-2xl bg-gray-200" />
        </div>
      ) : usageError || !usage ? (
        <p className="mt-2 rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
          Your Sparks numbers are napping — pull down to refresh, or try again in a moment. 😴
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-3 gap-3">
          <SparkStat n={usage.balance} label="⚡ available" />
          <SparkStat n={usage.used} label="⚡ used" />
          <SparkStat n={usage.added} label="⚡ added" />
        </div>
      )}

      {/* What each chat used — tap a chat to see what each request cost */}
      {usage && (
        <>
          <h2 className="mt-6 text-xs font-bold uppercase tracking-wide text-gray-500">What each chat used</h2>
          <div className="mt-2 rounded-2xl border border-gray-200 bg-white">
            {usage.chats.length === 0 ? (
              <p className="p-4 text-sm text-gray-600">No chats yet — build a game with Ari and it shows up here! 🚀</p>
            ) : (
              usage.chats.map((c, i) => (
                <div key={c.id} className={i > 0 ? "border-t border-gray-100" : ""}>
                  <button
                    onClick={() => void toggleChat(c.id)}
                    aria-expanded={openChat === c.id}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{c.title}</span>
                    <span className="shrink-0 text-sm font-extrabold text-[var(--ar-accent,#ff5c00)]">⚡ {formatSparks(c.sparks)}</span>
                    <span className="shrink-0 text-xs text-gray-400" aria-hidden="true">{openChat === c.id ? "▴" : "▾"}</span>
                  </button>
                  {openChat === c.id && (
                    <div className="border-t border-dashed border-gray-100 bg-gray-50 px-4 py-2">
                      {asks[c.id] === "loading" || !asks[c.id] ? (
                        <div className="animate-pulse space-y-2 py-1">
                          <div className="h-4 w-3/4 rounded bg-gray-200" />
                          <div className="h-4 w-1/2 rounded bg-gray-200" />
                        </div>
                      ) : asks[c.id] === "error" ? (
                        <p className="py-1 text-xs text-gray-600">Couldn't load this chat's requests — tap again to retry.</p>
                      ) : (asks[c.id] as UsageAsk[]).length === 0 ? (
                        <p className="py-1 text-xs text-gray-600">No requests in this chat yet.</p>
                      ) : (
                        (asks[c.id] as UsageAsk[]).map((a, j) => (
                          <div key={`${c.id}-${j}`} className="flex items-start gap-3 py-1.5 text-xs">
                            <span className="min-w-0 flex-1 text-gray-700">{a.ask || "(a request)"}</span>
                            <span className="shrink-0 font-bold text-gray-800">
                              {a.sparks == null ? <span className="font-normal text-gray-400">not counted</span> : `⚡ ${formatSparks(a.sparks)}`}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* Trophy stats — numbers that only ever go UP */}
      <div className="grid grid-cols-3 gap-3">
        <Stat n={wallet.gamesBuilt} label="games built" />
        <Stat n={wallet.earnedTotal} label="⚡ earned" />
        <Stat n={wallet.friendsJoined} label="friends" />
      </div>

      {/* Gauge — quiet when healthy, gentle nudge when low */}
      {wallet.gauge === "low" ? (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <span className="font-bold">⚡ Build energy is getting low.</span>{" "}
          Chatting with Ari is always free — and a parent can recharge building anytime from the Parent page. 💛
        </div>
      ) : (
        <div className="mt-4 flex items-center justify-between rounded-2xl border border-gray-200 bg-white p-4 text-sm">
          <span className="text-gray-600">Build energy</span>
          <span className="font-bold text-emerald-600">Good ✓</span>
        </div>
      )}

      {/* Sparks you earned — the celebration history (credits only) */}
      <h2 className="mt-6 text-xs font-bold uppercase tracking-wide text-gray-500">Sparks you earned</h2>
      <div className="mt-2 rounded-2xl border border-gray-200 bg-white p-4">
        {wallet.earned.length === 0 ? (
          <p className="text-sm text-gray-600">
            Your first Sparks are waiting — build a game with Ari, or add a coupon below! 🚀
          </p>
        ) : (
          wallet.earned.map((r, i) => (
            <div key={r.id} className={`flex items-center gap-3 py-3 ${i > 0 ? "border-t border-gray-100" : ""}`}>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-lg">
                {KIND_ICON[r.kind] ?? "⚡"}
              </div>
              <div className="min-w-0 text-sm">{r.note ?? "Sparks earned"}</div>
              <div className="ml-auto shrink-0 font-extrabold text-emerald-600">+{r.amount.toLocaleString()}</div>
            </div>
          ))
        )}
      </div>

      {/* Invite a friend */}
      <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4">
        <div className="font-extrabold">💜 Invite a friend — you both get ⚡</div>
        <div className="mt-2 rounded-xl bg-orange-50 py-2 text-center text-xl font-black tracking-[0.18em] text-[var(--ar-accent,#ff5c00)]">
          {wallet.referralCode}
        </div>
        <button onClick={copyInvite} className="mt-3 w-full rounded-xl border border-gray-300 bg-white py-2.5 text-sm font-bold">
          {copied ? "Copied! 🎉" : "Copy invite link"}
        </button>
      </div>

      {/* Coupon */}
      <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4">
        <div className="font-extrabold">🎟️ Have a coupon?</div>
        <div className="mt-2 flex gap-2">
          <input
            value={coupon}
            onChange={(e) => setCoupon(e.target.value)}
            placeholder="CODE"
            className="w-full rounded-xl border-2 border-dashed border-gray-300 px-3 py-2 text-center font-bold uppercase tracking-widest"
            aria-label="Coupon code"
          />
          <button onClick={redeem} className="rounded-xl bg-[var(--ar-accent,#ff5c00)] px-4 font-bold text-white">
            Add
          </button>
        </div>
        {couponMsg && <p className="mt-2 text-sm">{couponMsg}</p>}
      </div>
    </main>
  );
}

/** A Sparks number that may be unknown (platform down) — shows "—", never NaN. */
function SparkStat({ n, label }: { n: number | null; label: string }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white py-4 text-center">
      <div className="text-2xl font-black text-[var(--ar-accent,#ff5c00)]">{n == null ? "—" : formatSparks(n)}</div>
      <div className="mt-0.5 text-[11px] text-gray-500">{label}</div>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white py-4 text-center">
      <div className="text-2xl font-black text-[var(--ar-accent,#ff5c00)]">{n.toLocaleString()}</div>
      <div className="mt-0.5 text-[11px] text-gray-500">{label}</div>
    </div>
  );
}
