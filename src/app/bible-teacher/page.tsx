// Bible-teacher authoring surface (PRD-BIBLE-TEACHER). Same chat/build UX as the
// kid home, but rendered in persona mode: the client sends `persona:
// "bible-teacher"` to /api/chat, which the SERVER fail-closes to a verified-adult
// session (resolvePersona) before honoring the teacher prompt + relaxed authoring
// safety. Entry is non-blocking — a visitor gets a small free trial, then a
// sign-in + self-declared-adult gate (enforced server-side via the token gate).
//
// Deliberately noindex: this is a gated authoring tool reached by an open link
// from a partner teacher app, NOT public content for kids or search to discover.

import type { Metadata } from "next";
import { ChatPanelContainer } from "@/components/ChatPanel.container";

const PAGE_URL = "https://games-lab.ariantra.com/bible-teacher";

export const metadata: Metadata = {
  title: "Ari for Bible Teachers — build scripture-faithful games",
  description:
    "A studio for Sunday-school and kids' Bible teachers to build accurate, wholesome scripture games for their class — powered by Ari.",
  alternates: { canonical: PAGE_URL },
  // Gated authoring surface — keep it out of search/AI indexes (the login + age
  // gate is the real control; discoverability is not a goal here).
  robots: { index: false, follow: false },
};

export default function BibleTeacherPage() {
  return <ChatPanelContainer persona="bible-teacher" />;
}
