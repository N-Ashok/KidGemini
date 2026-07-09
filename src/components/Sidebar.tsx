"use client";
// Gemini-style left sidebar: brand, New chat, search, recent conversations, profile.
// Presentational; raises events via props. Recents are passed in by the container.
// The profile footer reflects the Auth.js session: real account when signed in, else a
// "Sign in to Ariantra" button (mirrors how Gemini surfaces the account).

import { useState } from "react";
import { useSession, signIn, signOut } from "@/lib/useAriantraSession";

interface RecentItem {
  id: string;
  title: string;
}

interface SidebarProps {
  recents: RecentItem[];
  activeId: string | null;
  isOpen: boolean;
  /** Live filter over recents (title + message text) — owned by the container. */
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onClose: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const { recents, activeId, isOpen, searchQuery, onSearchChange, onClose, onNewChat, onSelect } = props;
  const [isSearching, setIsSearching] = useState(false);
  function closeSearch() {
    onSearchChange("");
    setIsSearching(false);
  }
  const { data: session } = useSession();
  const user = session?.user ?? null;
  const initial = (user?.name ?? user?.email ?? "?").charAt(0).toUpperCase();
  return (
    <>
      {/* Mobile scrim — tap to dismiss the drawer. Hidden on md+ where the sidebar is static. */}
      {isOpen && (
        <button
          aria-label="Close menu"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-neutral-900/30 md:hidden"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-neutral-200
                    bg-neutral-50 transition-transform duration-200 md:static md:z-auto md:translate-x-0
                    ${isOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="text-xl" aria-hidden>✨</span>
        <span className="text-lg font-semibold text-neutral-700">KidGemini</span>
        <button
          aria-label="Close menu"
          onClick={onClose}
          className="ml-auto rounded-lg p-1 text-neutral-500 hover:bg-neutral-200/60 md:hidden"
        >
          ✕
        </button>
      </div>

      <div className="px-3">
        <button
          onClick={onNewChat}
          className="flex w-full items-center gap-3 rounded-full bg-neutral-200/70 px-4 py-2.5
                     text-sm font-medium text-neutral-700 hover:bg-neutral-200"
        >
          <span aria-hidden>✏️</span> New chat
        </button>
      </div>

      <nav className="mt-2 px-3 text-sm text-neutral-600">
        {isSearching ? (
          <div className="flex w-full items-center gap-2 rounded-lg bg-white px-3 py-1.5 ring-1 ring-neutral-300">
            <span aria-hidden>🔍</span>
            <input
              autoFocus
              type="text"
              value={searchQuery}
              placeholder="Search chats"
              aria-label="Search chats"
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && closeSearch()}
              className="w-full min-w-0 bg-transparent py-0.5 text-sm text-neutral-700 outline-none
                         placeholder:text-neutral-400"
            />
            <button
              aria-label="Close search"
              title="Close search"
              onClick={closeSearch}
              className="rounded-lg px-1 text-neutral-500 hover:bg-neutral-200/60"
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={() => setIsSearching(true)}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 hover:bg-neutral-200/60"
          >
            <span aria-hidden>🔍</span> Search chats
          </button>
        )}
        <a
          href="/upgrade"
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 hover:bg-neutral-200/60"
        >
          <span aria-hidden>✨</span> Go premium
        </a>
        <a
          href="/parent"
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 hover:bg-neutral-200/60"
        >
          <span aria-hidden>🛡️</span> Parent area
        </a>
        <a
          href="/admin"
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 hover:bg-neutral-200/60"
        >
          <span aria-hidden>📊</span> Usage &amp; cost
        </a>
      </nav>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-3">
        <p className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
          {searchQuery.trim()
            ? `Recent — ${recents.length} ${recents.length === 1 ? "match" : "matches"}`
            : "Recent"}
        </p>
        <ul className="space-y-0.5">
          {recents.length === 0 && (
            <li className="px-3 py-2 text-xs text-neutral-400">
              {searchQuery.trim()
                ? "No chats found — try another word, or start a New chat."
                : "No chats yet"}
            </li>
          )}
          {recents.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => {
                  closeSearch();
                  onSelect(r.id);
                }}
                className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm
                  ${r.id === activeId ? "bg-neutral-200 text-neutral-900" : "text-neutral-600 hover:bg-neutral-200/60"}`}
                title={r.title}
              >
                {r.title}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-neutral-200 px-3 py-3">
        {user ? (
          <div className="flex items-center gap-3">
            {user.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.image} alt="" className="h-8 w-8 rounded-full" />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-700 text-sm text-white">
                {initial}
              </span>
            )}
            <div className="min-w-0 text-sm leading-tight">
              <p className="truncate font-medium text-neutral-700">{user.name ?? user.email}</p>
              <p className="text-xs text-neutral-400">Signed in</p>
            </div>
            <button
              onClick={() => signOut()}
              className="ml-auto rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-200/60"
            >
              Sign out
            </button>
          </div>
        ) : (
          <button
            onClick={() => signIn()}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-neutral-300
                       bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            <span aria-hidden>🔆</span> Sign in to Ariantra
          </button>
        )}
      </div>
      </aside>
    </>
  );
}
