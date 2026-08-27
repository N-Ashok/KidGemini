// /wallet — the kid-facing Sparks page (PRD-SPARKS Phase 4, mock v2
// 2026-07-25). Celebration-first: games built, ⚡ earned, friends joined,
// credits-only history, referral code, coupon entry. Since 2026-08-27 (owner
// decision, docs/2026-08-27_PRD_SparksPage.md) it ALSO shows ⚡ available /
// used / added, what each chat used and what each request cost — everyone
// sees it. Rupees stay in the Parent tab.
import type { Metadata } from "next";
import { WalletPanel } from "@/components/WalletPanel";

export const metadata: Metadata = {
  title: "My Sparks ⚡ — Games-Lab",
  description: "Your Sparks: what you have, what each chat used, games you built, and ways to earn more.",
  robots: { index: false }, // signed-in kid surface — never a search result
};

export default function WalletPage() {
  return <WalletPanel />;
}
