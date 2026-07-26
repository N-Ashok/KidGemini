// PRD-SPARKS closure §4 — celebration card logic for the publish "done"
// screen: the amount comes from the PLATFORM's wallet credits feed (the
// ledger is the truth), never a hardcoded number. Kept pure so the card is
// testable without the component.

export interface EarnedRowLite {
  kind: string;
  amount: number;
  gameSlug?: string;
}

/** The live URL is `https://{slug}.ariantra.com/` — same reserved-label rules
 *  as the platform's tenancy: multi-label hosts (games.ariantra.com paths)
 *  are surfaces, not games. */
export function slugFromLiveUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const m = /^([a-z0-9-]+)\.ariantra\.com$/.exec(host);
    const label = m?.[1];
    if (!label) return null;
    const RESERVED = new Set(["www", "games", "studio", "api", "ari", "games-lab", "kidgemini", "signal", "catalog"]);
    return RESERVED.has(label) ? null : label;
  } catch {
    return null;
  }
}

/** The publish reward for THIS game, if the wallet feed carries one.
 *  Null = no card (republish no-op, rewards off, feed unavailable) — the
 *  publish flow itself never depends on this. */
export function publishCelebration(
  earned: EarnedRowLite[] | undefined,
  slug: string | null,
): { amount: number } | null {
  if (!earned || !slug) return null;
  const match = earned.find((r) => r.kind === "publish_reward" && r.gameSlug === slug && r.amount > 0);
  return match ? { amount: match.amount } : null;
}

/** The whole fetch-and-pick the publish done screen does, injectable fetch so
 *  it's testable. NEVER rejects — any failure (HTTP, network, junk JSON) is
 *  "no card", because Sparks must not wobble the publish celebration. */
export async function fetchPublishCelebration(
  liveUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ amount: number } | null> {
  try {
    const res = await fetchImpl("/api/wallet");
    if (!res.ok) return null;
    const w = (await res.json()) as { earned?: EarnedRowLite[] };
    return publishCelebration(w.earned, slugFromLiveUrl(liveUrl));
  } catch {
    return null;
  }
}
