"use client";
// "🚀 Put it in the Arcade" — bottom-sheet flow (design 2026-07-07, approved):
// name → grown-up PIN → lift-off progress → celebration. Kid-styled: big
// targets, short words, nothing scary. The server route enforces the real
// gates; this component only renders states.

import { useCallback, useEffect, useRef, useState } from "react";
import { nameToSlug } from "@/lib/arcade";
import { whatsappShareUrl } from "@/lib/share-links";
import { GAME_CATEGORIES } from "@/lib/game-categories";
import { MULTIPLAYER_MARKER } from "@/lib/multiplayer-gate";
import { signIn, verifyAge, useSession } from "@/lib/useAriantraSession";
import { INITIAL_PUBLISH_STEP, stepAfterGamesLoad, type PublishStep } from "@/lib/publish-flow";

interface Props {
  html: string;
  suggestedName?: string;
  onClose: () => void;
  /** Bible-teacher surface (PRD-BIBLE-TEACHER §5): the game is fixed to the
   *  "Bible games" category — no picker — and published into the separate Bible
   *  listing. Surface-driven (true whenever authored on /bible-teacher), not
   *  adult-gated — age verification gates ACCESS to the surface, not publishing. */
  bibleGame?: boolean;
}

// Step sequencing lives in lib/publish-flow.ts (pure + unit-tested).
type Step = PublishStep;

interface MyGame {
  slug: string;
  name: string;
  status: string;
}

const NAME_IDEAS = [
  "Sky Dragon", "Star Dash", "Robo Run", "Mega Maze", "Pixel Quest",
  "Turbo Trails", "Moon Hopper", "Laser Legend", "Wobble World", "Rocket Rally",
];

// WhatsApp share is a plain anchor to wa.me — see src/lib/share-links.ts for
// why the whatsapp:// deep-link + delayed-window.open approach is banned
// (BUG-FIX-LOG 2026-07-18: it silently opened nothing without the app).

export function PublishToArcade({ html, suggestedName, onClose, bibleGame = false }: Props) {
  // Opens on `loading`, NOT a guess (BUG-FIX-LOG 2026-07-24): starting on
  // "name" meant a kid with existing games saw the naming screen, lost it to
  // "What are we doing?" when the list arrived, then got it back after
  // choosing "brand-new" — three modals for one decision.
  const [step, setStep] = useState<Step>(INITIAL_PUBLISH_STEP);
  // Sign-in is checked FIRST (before the kid invests in naming + PIN): the
  // family account is required to publish, and signIn() round-trips back to
  // this exact page — the chat survives via chat-store.
  const { status: authStatus } = useSession();
  const [myGames, setMyGames] = useState<MyGame[] | null>(null); // null = not fetched
  const [updateTarget, setUpdateTarget] = useState<MyGame | null>(null);
  // A failed fetch used to look identical to "you have zero games" — the kid
  // got silently routed into "publish new" with no sign anything went wrong,
  // even if they actually had games that should have offered "update"
  // instead (2026-07-17, same shape as the Sidebar Recents fix this session).
  const [gamesLoadError, setGamesLoadError] = useState(false);
  const [gamesLoadTick, setGamesLoadTick] = useState(0);

  // Signed in → fetch the kid's games; any existing ones mean we ASK first:
  // brand-new game, or update one of theirs (user decision 2026-07-07).
  useEffect(() => {
    if (authStatus === "unauthenticated") { setStep("signin"); return; }
    if (authStatus !== "authenticated") return;
    let alive = true;
    setGamesLoadError(false);
    fetch("/api/arcade/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ list: true }),
    })
      .then((r) => {
        if (!r.ok) {
          if (alive) setGamesLoadError(true);
          return { games: [] };
        }
        return r.json();
      })
      .then((d: { games?: MyGame[] }) => {
        if (!alive) return;
        const games = d.games ?? [];
        setMyGames(games);
        setStep((s) => stepAfterGamesLoad({ current: s, gameCount: games.length }));
      })
      .catch(() => {
        if (!alive) return;
        setGamesLoadError(true);
        setMyGames([]);
        // Don't strand the kid on the spinner — the name step carries the
        // "couldn't check your games — tap to retry" affordance.
        setStep((s) => stepAfterGamesLoad({ current: s, gameCount: 0 }));
      });
    return () => {
      alive = false;
    };
  }, [authStatus, gamesLoadTick]);
  const [name, setName] = useState(suggestedName ?? "");
  // Category + play-mode (owner ask 2026-07-18): the kid picks a real
  // category (no more everything-lands-in-Arcade) and explicitly chooses
  // single vs multiplayer. Play mode defaults to single player; it's only
  // offered — and preselected — when the game actually carries multiplayer
  // code (the USES_MULTIPLAYER marker), because choosing multiplayer for a
  // single-player game would ship a dead lobby (the server enforces the
  // same AND, route.ts).
  const [category, setCategory] = useState<string | null>(null);
  const hasMpCode = html.includes(MULTIPLAYER_MARKER);
  const [playMode, setPlayMode] = useState<"single" | "friends">(hasMpCode ? "friends" : "single");
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "free" | "taken" | "mine" | "copyright" | "unknown"; suggestions: string[]; matched?: string }>({ state: "idle", suggestions: [] });
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [liveUrl, setLiveUrl] = useState("");
  const [stage, setStage] = useState(0);
  // PRD-SHARING Phase 1 (S1, "I made this!"): the publish response carries
  // shareEnabled/credit (account-level Sharing & Privacy, set in Studio) —
  // no extra round trip needed for the share card below.
  const [shareEnabled, setShareEnabled] = useState(false);
  const [shareMessage, setShareMessage] = useState("");
  const [shareConfirmed, setShareConfirmed] = useState(false);
  // Where the game ACTUALLY landed — read from the publish response, not the
  // client's assumption, so the "done" screen never points at Bible games when
  // the server (fail-closed on the adult claim) filed it in the general catalog.
  const [landedBible, setLandedBible] = useState(false);
  const checkTimer = useRef<ReturnType<typeof setTimeout>>();

  const slug = updateTarget ? updateTarget.slug : nameToSlug(name);
  const displayName = updateTarget ? updateTarget.name : name;
  const isUpdate = updateTarget !== null || check.state === "mine"; // republishing the kid's own game

  // Debounced availability check while the kid types.
  useEffect(() => {
    setCheck({ state: "idle", suggestions: [] });
    if (!slug) return;
    clearTimeout(checkTimer.current);
    setCheck({ state: "checking", suggestions: [] });
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/arcade/publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ check: true, name }),
        });
        const data = (await res.json()) as { free?: boolean; mine?: boolean; matched?: string; suggestions?: string[] };
        // "taken"/"copyright" ONLY on a confirmed answer — a failed check
        // (network, server) must not claim the name is gone; publish
        // re-validates server-side either way.
        if (res.ok && data.free === true) setCheck({ state: "free", suggestions: [] });
        else if (res.ok && data.free === false && data.mine === true) setCheck({ state: "mine", suggestions: [] });
        else if (res.ok && data.free === false && data.matched) setCheck({ state: "copyright", suggestions: data.suggestions ?? [], matched: data.matched });
        else if (res.ok && data.free === false) setCheck({ state: "taken", suggestions: data.suggestions ?? [] });
        else setCheck({ state: "unknown", suggestions: [] });
      } catch {
        setCheck({ state: "unknown", suggestions: [] });
      }
    }, 450);
    return () => clearTimeout(checkTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const shuffle = () => {
    const pick = NAME_IDEAS[Math.floor(Math.random() * NAME_IDEAS.length)]!;
    setName(pick);
  };

  // targetOverride: the update picker calls publish in the same tick as
  // setUpdateTarget — state would be stale, so the picked game rides along.
  const publish = useCallback(async (targetOverride?: MyGame) => {
    const target = targetOverride ?? updateTarget;
    setStep("publishing");
    setError("");
    setStage(1);
    // Stages 1-3 animate on a timer (they map to real phases but we only get
    // one response); the last stage completes when the server answers.
    const t1 = setTimeout(() => setStage(2), 900);
    const t2 = setTimeout(() => setStage(3), 1900);
    try {
      const res = await fetch("/api/arcade/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: target ? target.name : displayName,
          html,
          ...(target ? { slug: target.slug } : {}),
          ...(category ? { category } : {}),
          multiplayer: playMode === "friends",
          ...(bibleGame ? { bibleGame: true } : {}),
        }),
      });
      const data = (await res.json()) as {
        url?: string; error?: string; suggestions?: string[]; matched?: string;
        shareEnabled?: boolean; credit?: { name?: string; age?: number; place?: string } | null;
        bibleGame?: boolean;
      };
      clearTimeout(t1);
      clearTimeout(t2);
      // parent_required: no live parent session yet — ask for the PIN. (If a
      // grown-up verified within the last 30 min, this never shows.)
      if (res.status === 403) { setStep("pin"); setPin(""); return; }
      if (res.status === 401) { setStep("signin"); return; } // session expired mid-flow
      if (res.status === 409) { setStep("name"); setCheck({ state: "taken", suggestions: data.suggestions ?? [] }); return; }
      // 451 "Unavailable For Legal Reasons" — the name/slug matches a known
      // trademarked property (copyright-policy.ts). Same "back to naming,
      // here are alternatives" flow as a taken name, distinct messaging.
      if (res.status === 451) { setStep("name"); setCheck({ state: "copyright", suggestions: data.suggestions ?? [], matched: data.matched }); return; }
      if (!res.ok || !data.url) { setStep("pin"); setError(data.error ?? "That didn't work — nothing is broken. Try again in a minute."); return; }
      setStage(4);
      setLiveUrl(data.url);
      setShareEnabled(data.shareEnabled === true);
      setLandedBible(data.bibleGame === true);
      // Copy rewrite (2026-07-17): the kid is the hook, not the platform — a
      // named "a 10-year-old made this" beats any platform tagline, and "no
      // download" removes WhatsApp's one real objection. Brand tagline lives
      // in the game's OG description (platform's seo.ts), not repeated here.
      // No non-BMP emoji (🎮/👾/etc.) in message text — wa.me's own redirect
      // to api.whatsapp.com corrupts them into the UTF-8 replacement
      // character, verified independently of our code via a raw wa.me request.
      setShareMessage(
        data.credit?.name
          ? `${data.credit.name}${data.credit.age ? `, ${data.credit.age},` : ""} made a game. Actual playable game, in the browser, no download.\n${data.url}`
          : `I made a game! Play it here.\n${data.url}\n(Built it on Ariantra — kids make the games.)`,
      );
      setShareConfirmed(false);
      setTimeout(() => setStep("done"), 700);
    } catch {
      clearTimeout(t1);
      clearTimeout(t2);
      setStep("pin");
      setError("That didn't work — nothing is broken. Check the internet and try again.");
    }
  }, [displayName, html, updateTarget, category, playMode, bibleGame]);

  // PIN step: verify against /api/parent/verify-pin (which sets the HttpOnly
  // parent-session cookie), THEN publish. The PIN itself never rides on the
  // publish request (PRD-PARENT-AUTH-ALERT-SCOPING §8).
  const verifyThenPublish = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/parent/verify-pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        setPin("");
        return publish();
      }
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        attemptsLeft?: number;
        unlockAt?: number;
      };
      if (res.status === 401 && data.error === "signed_out") { setStep("signin"); return; }
      if (res.status === 404) {
        setError("No parent PIN is set up yet — a grown-up can set one in the Parent area first.");
        return;
      }
      if (res.status === 429) {
        const at = data.unlockAt ? new Date(data.unlockAt).toLocaleTimeString() : "later";
        setError(`Too many tries — the PIN is locked until ${at}.`);
        return;
      }
      setError(
        `That's not the right PIN — try again!${
          typeof data.attemptsLeft === "number" ? ` (${data.attemptsLeft} tries left)` : ""
        }`,
      );
      setPin("");
    } catch {
      setError("That didn't work — nothing is broken. Check the internet and try again.");
    }
  }, [pin, publish]);

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl bg-white p-5 pb-7 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-neutral-200" />

        {/* Skeleton, not a blank sheet and not a guessed step: we're waiting to
            learn whether this kid already has games in the Arcade. */}
        {step === "loading" && (
          <div className="py-2" role="status" aria-live="polite">
            <h3 className="font-display text-xl font-bold">Getting the launchpad ready… 🚀</h3>
            <p className="mb-4 text-sm text-neutral-500">One second — checking your Arcade.</p>
            <div className="mb-2 h-12 w-full animate-pulse rounded-2xl bg-neutral-100" />
            <div className="h-12 w-full animate-pulse rounded-2xl bg-neutral-100" />
          </div>
        )}

        {step === "signin" && (
          <>
            <h3 className="font-display text-xl font-bold">
              {bibleGame ? "Sign in to publish 📖" : "Ask a grown-up to sign in 🧑‍🚀"}
            </h3>
            <p className="mb-4 text-sm text-neutral-500">
              {bibleGame ? (
                <>
                  Bible games publish under your Ariantra teacher account. Sign in and confirm
                  you&rsquo;re a grown-up — you&rsquo;ll come straight back here, <b>your work is safe</b>.
                </>
              ) : (
                <>
                  Games publish under your family&rsquo;s Ariantra account. Sign in and you&rsquo;ll come
                  straight back here — <b>your chat and game are safe</b>.
                </>
              )}
            </p>
            <button
              // Teacher surface: route through the age gate (verifyAge) so the
              // teacher clears the adult check ONCE and then publishes PIN-free.
              // Kid surface: plain sign-in → parent-PIN approval still applies.
              onClick={() => (bibleGame ? verifyAge() : signIn())}
              className="w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white shadow-lg shadow-orange-500/30"
            >
              Sign in →
            </button>
          </>
        )}

        {step === "choose" && (
          <>
            <h3 className="font-display text-xl font-bold">What are we doing? 🎮</h3>
            <p className="mb-4 text-sm text-neutral-500">You already have {myGames?.length === 1 ? "a game" : "games"} in the Arcade!</p>
            <button
              onClick={() => { setUpdateTarget(null); setStep("name"); }}
              className="mb-2 w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white shadow-lg shadow-orange-500/30"
            >
              🆕 Publish a brand-new game
            </button>
            <button
              onClick={() => setStep("pick")}
              className="w-full rounded-2xl border-2 border-neutral-200 py-3.5 text-base font-bold text-neutral-800 hover:border-orange-400"
            >
              🔄 Update one of my games
            </button>
          </>
        )}

        {step === "pick" && (
          <>
            <h3 className="font-display text-xl font-bold">Which game gets the new version? 🔄</h3>
            <p className="mb-3 text-sm text-neutral-500">Same address — the new version replaces the old one.</p>
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {(myGames ?? []).map((g) => (
                <button
                  key={g.slug}
                  onClick={() => { setUpdateTarget(g); void publish(g); }}
                  className="flex w-full items-center justify-between rounded-2xl border-2 border-neutral-200 px-4 py-3 text-left hover:border-orange-400"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-base font-bold">{g.name}</span>
                    <span className="block truncate text-xs text-neutral-400">{g.slug}.ariantra.com</span>
                  </span>
                  <span className="ml-2 shrink-0 text-sm font-extrabold text-orange-500">Update →</span>
                </button>
              ))}
            </div>
            <button onClick={() => setStep("choose")} className="mt-3 w-full py-2 text-sm font-bold text-neutral-500">
              ← Back
            </button>
          </>
        )}

        {step === "name" && (
          <>
            <h3 className="font-display text-xl font-bold">Name your game! 🎮</h3>
            <p className="mb-3 text-sm text-neutral-500">This becomes its very own web address.</p>
            {gamesLoadError && (
              <button
                type="button"
                onClick={() => setGamesLoadTick((t) => t + 1)}
                className="mb-3 w-full rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-left text-xs font-bold text-amber-700"
              >
                ⚠️ Couldn&rsquo;t check your existing games — tap to retry
              </button>
            )}
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Dragon Flyer"
              className="w-full rounded-xl border-2 border-orange-500 px-4 py-3 text-base font-bold outline-none"
            />
            <p className="mt-2 min-h-5 text-xs font-bold">
              {check.state === "checking" && <span className="text-neutral-400">checking…</span>}
              {check.state === "free" && <span className="text-emerald-600">✓ {slug}.ariantra.com is free!</span>}
              {check.state === "mine" && <span className="text-emerald-600">🔄 that&rsquo;s YOUR game — this updates {slug}.ariantra.com!</span>}
              {check.state === "taken" && <span className="text-red-500">someone got that one first — try a 🎲 idea!</span>}
              {check.state === "copyright" && (
                <span className="text-red-500">
                  &ldquo;{check.matched}&rdquo; belongs to a big company, not you — pick your OWN game name and it&rsquo;ll be even cooler! 🌟
                </span>
              )}
              {check.state === "unknown" && <span className="text-neutral-400">couldn&rsquo;t check the name — you can still continue</span>}
            </p>
            <div className="mb-4 mt-1 flex flex-wrap gap-1.5">
              {((check.state === "taken" || check.state === "copyright") && check.suggestions.length > 0 ? check.suggestions : []).map((s) => (
                <button key={s} onClick={() => setName(s.replace(/-/g, " "))} className="rounded-full border border-neutral-200 px-3 py-1 text-xs font-bold text-neutral-600 hover:border-orange-400">
                  {s}
                </button>
              ))}
              <button onClick={shuffle} className="rounded-full border border-neutral-200 px-3 py-1 text-xs font-bold text-neutral-600 hover:border-orange-400">
                🎲 give me an idea
              </button>
            </div>
            {bibleGame ? (
              // Category is FIXED on the teacher surface (PRD-BIBLE-TEACHER §5) —
              // no picker; the game lands on the separate Bible-games page.
              <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
                📖 This publishes to <span className="underline">Bible games</span>
              </div>
            ) : (
              <>
                <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-neutral-400">What kind of game is it?</p>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {GAME_CATEGORIES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCategory(c)}
                      aria-pressed={category === c}
                      className={`rounded-full border px-3 py-1 text-xs font-bold ${
                        category === c
                          ? "border-orange-500 bg-orange-500 text-white"
                          : "border-neutral-200 text-neutral-600 hover:border-orange-400"
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </>
            )}
            {hasMpCode && (
              <>
                <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-neutral-400">How is it played?</p>
                <div className="mb-3 flex gap-1.5">
                  {(
                    [
                      ["single", "🧍 Single player"],
                      ["friends", "🎮 With friends (2–5)"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setPlayMode(mode)}
                      aria-pressed={playMode === mode}
                      className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold ${
                        playMode === mode
                          ? "border-orange-500 bg-orange-500 text-white"
                          : "border-neutral-200 text-neutral-600 hover:border-orange-400"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
            <button
              // Category is required only in the general flow; the Bible surface
              // fixes it, so a bible publish never needs a category pick.
              disabled={!slug || (!bibleGame && !category) || check.state === "taken" || check.state === "copyright"}
              // Straight to publish: if a grown-up verified the PIN within
              // the last 30 min the game just goes; otherwise the server's
              // parent_required 403 routes to the PIN step.
              onClick={() => void publish()}
              className="w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white shadow-lg shadow-orange-500/30 disabled:opacity-40"
            >
              {isUpdate ? "Next → update my game" : "Next → ask a grown-up"}
            </button>
          </>
        )}

        {step === "pin" && (
          <>
            <h3 className="font-display text-xl font-bold">Ask a grown-up 🧑‍🚀</h3>
            <p className="mb-3 text-sm text-neutral-500">
              {isUpdate ? (
                <>This replaces the version of <b>{displayName}</b> that&rsquo;s already on the internet. A grown-up needs to say OK.</>
              ) : (
                <>Publishing puts <b>{displayName}</b> on the internet where anyone can play it. A grown-up needs to say OK.</>
              )}
            </p>
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              placeholder="Parent PIN"
              className="w-full rounded-xl border-2 border-neutral-200 px-4 py-3 text-center text-xl font-extrabold tracking-[0.5em] outline-none focus:border-orange-500"
            />
            <p className="mb-3 mt-1 text-center text-xs text-neutral-400">Same 4-digit PIN as the Parent area</p>
            {error && <p className="mb-2 text-center text-xs font-bold text-red-500">{error}</p>}
            <button
              disabled={pin.length !== 4}
              onClick={() => void verifyThenPublish()}
              className="w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white shadow-lg shadow-orange-500/30 disabled:opacity-40"
            >
              {isUpdate ? `🔄 Update ${displayName}` : `🚀 Publish ${displayName}`}
            </button>
          </>
        )}

        {step === "publishing" && (
          <div className="py-4 text-center">
            <div className="mb-2 text-5xl">🚀</div>
            <h3 className="font-display mb-3 text-xl font-bold">Lifting off…</h3>
            <ul className="mx-auto max-w-60 space-y-2 text-left text-sm font-bold">
              {["Packing your game", "Stamping your name on it", `Launching to ${slug}.ariantra.com`, "Taking its picture for the Arcade"].map((label, i) => (
                <li key={label} className={i + 1 < stage ? "text-emerald-600" : i + 1 === stage ? "text-neutral-900" : "text-neutral-300"}>
                  {i + 1 < stage ? "✅" : i + 1 === stage ? "🚀" : "◻"} {label}
                </li>
              ))}
            </ul>
          </div>
        )}

        {step === "done" && (
          <div className="py-2 text-center">
            <div className="mb-1 text-5xl">🏆</div>
            <h3 className="font-display text-xl font-bold">{displayName} is {isUpdate ? "UPDATED" : "LIVE"}! 🎉</h3>
            <p className="mb-3 text-sm text-neutral-500">{isUpdate ? "The new version is playing at the same address." : "You’re a real game maker now."}</p>
            <div className="mb-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-3">
              <div className="text-sm font-extrabold text-orange-600">{liveUrl.replace(/^https:\/\//, "").replace(/\/$/, "")}</div>
              <div className="mt-1 text-[11px] text-neutral-400">High scores &amp; leaderboard: ON automatically 🏆</div>
            </div>
            <a href={liveUrl} target="_blank" rel="noreferrer" className="mb-2 block w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white">
              ▶ Play at my address
            </a>
            <a
              href={landedBible ? "https://games.ariantra.com/bible-games" : "https://games.ariantra.com/"}
              target="_blank"
              rel="noreferrer"
              className="mb-3 block w-full rounded-2xl border-2 border-neutral-200 py-3 text-base font-bold text-neutral-800"
            >
              {landedBible ? "📖 See it in Bible games" : "🕹 See it in the Arcade"}
            </a>

            {shareEnabled ? (
              shareConfirmed ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-center">
                  <div className="text-2xl">🎉</div>
                  <div className="text-sm font-extrabold text-emerald-700">Nice! Thanks for sharing.</div>
                </div>
              ) : (
                <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-3 text-left">
                  <div className="mb-2 text-xs font-bold uppercase tracking-wide text-neutral-400">Share it 🔗</div>
                  <textarea
                    value={shareMessage}
                    onChange={(e) => setShareMessage(e.target.value)}
                    className="mb-2 w-full rounded-xl border border-neutral-200 bg-white p-2 text-sm outline-none focus:border-orange-400"
                    rows={2}
                  />
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={whatsappShareUrl(shareMessage)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setShareConfirmed(true)}
                      className="rounded-full bg-[#25d366] px-3.5 py-2 text-xs font-extrabold text-white no-underline"
                    >
                      💬 WhatsApp
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        if (navigator.share) navigator.share({ text: shareMessage, url: liveUrl }).then(() => setShareConfirmed(true)).catch(() => {});
                        else setShareConfirmed(true);
                      }}
                      className="rounded-full bg-orange-500 px-3.5 py-2 text-xs font-extrabold text-white"
                    >
                      📲 More…
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(liveUrl).catch(() => {});
                        setShareConfirmed(true);
                      }}
                      className="rounded-full border border-neutral-200 bg-white px-3.5 py-2 text-xs font-extrabold text-neutral-700"
                    >
                      🔗 Copy link
                    </button>
                  </div>
                </div>
              )
            ) : (
              <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-3 text-center">
                <div className="text-sm font-bold text-neutral-700">🔒 Ask a grown-up to turn on sharing</div>
                <p className="mt-1 text-xs text-neutral-500">Once they turn it on in the Parent area, you can share this game anytime.</p>
                <a href="/parent" className="mt-2 inline-block text-xs font-extrabold text-orange-600">
                  Open Parent area →
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
