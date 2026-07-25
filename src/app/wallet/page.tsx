// /wallet — the kid-facing Sparks page (PRD-SPARKS Phase 4, mock v2
// 2026-07-25). Celebration-first: games built, ⚡ earned, friends joined,
// credits-only history, referral code, coupon entry. NEVER shows deductions,
// exact balance, or rupees — that precision lives in the Parent tab. The
// gauge only turns into a gentle nudge below the low threshold.
import type { Metadata } from "next";
import { WalletPanel } from "@/components/WalletPanel";

export const metadata: Metadata = {
  title: "My Sparks ⚡ — Games-Lab",
  description: "Your Sparks: games you built, Sparks you earned, and ways to earn more.",
  robots: { index: false }, // signed-in kid surface — never a search result
};

export default function WalletPage() {
  return <WalletPanel />;
}
