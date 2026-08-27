"use client";
// Gemini-style left sidebar: brand, New chat, search, recent conversations, profile.
// Presentational; raises events via props. Recents are passed in by the container.
// The profile footer reflects the Auth.js session: real account when signed in, else a
// "Sign in to Ariantra" button (mirrors how Gemini surfaces the account).
//
// Desktop collapse (2026-07-17): `collapsed` shrinks the aside to an icon rail.
// Labels/search/Recent hide via an `md:hidden` CLASS (never JS-conditional
// rendering) so the mobile drawer — a separate isOpen/onClose overlay that's
// always full width — is never affected by desktop's collapsed state.

import { useEffect, useRef, useState } from "react";
import { useSession, signIn, signOut } from "@/lib/useAriantraSession";
import { formatSparks } from "@/lib/sparks-display";

interface RecentItem {
  id: string;
  title: string;
  /** Timestamp when pinned, null/absent otherwise — pinned rows are sorted
   *  first by the container (chat-organize.ts). */
  pinnedAt?: number | null;
  /** Sparks this chat has used so far (sum of its replies' receipts,
   *  docs/2026-08-27_PRD_SparksPage.md §2b). Absent/0 → nothing shown. */
  sparks?: number;
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
  /** Soft delete (owner ask 2026-07-26): hides the chat from this account's
   *  view — server keeps the row. Fired only after the in-row confirm tap. */
  onDelete: (id: string) => void;
  /** Rename via the ⋮ menu (owner ask 2026-08-06) — fired with the trimmed
   *  non-empty new title after the in-row editor confirms. */
  onRename: (id: string, title: string) => void;
  /** Pin/unpin toggle via the ⋮ menu (owner ask 2026-08-06). */
  onTogglePin: (id: string) => void;
  /** Share via the ⋮ menu (2026-08-06_PRD_ShareConversation.md) — opens the
   *  parent-gated ShareChat sheet; all gating lives there, not here. */
  onShare: (id: string) => void;
  /** True while the server has older chats beyond the loaded index. */
  hasMore?: boolean;
  /** Scrolling near the bottom of Recents asks the container for the next page. */
  onEndReached?: () => void;
  /** True when the last Recents fetch failed — the list may be missing chats
   *  that exist server-side, not just genuinely empty. */
  recentsError?: boolean;
  onRetryRecents?: () => void;
  /** Desktop-only icon-rail collapse; ignored below md (mobile drawer is always full). */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function Sidebar(props: SidebarProps) {
  const {
    recents, activeId, isOpen, searchQuery, onSearchChange, onClose, onNewChat, onSelect,
    onDelete, onRename, onTogglePin, onShare, hasMore, onEndReached, recentsError, onRetryRecents,
    collapsed, onToggleCollapsed,
  } = props;
  const [isSearching, setIsSearching] = useState(false);
  // Two-tap delete: the 🗑️ tap swaps the row for an in-row "Delete / Keep"
  // confirm — no browser confirm() popup, no accidental one-tap loss.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // ⋮ per-row menu (owner ask 2026-08-06: Rename / Pin / Delete — replaces
  // the lone hover-✕, which offered delete only). One open at a time;
  // outside-click closes via the transparent full-screen backdrop below.
  const [menuId, setMenuId] = useState<string | null>(null);
  // In-row rename editor, same swap-the-row pattern as the delete confirm.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  function commitRename(id: string) {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (title) onRename(id, title);
  }
  function closeSearch() {
    onSearchChange("");
    setIsSearching(false);
  }
  const { data: session } = useSession();
  const user = session?.user ?? null;
  const initial = (user?.name ?? user?.email ?? "?").charAt(0).toUpperCase();

  // Expanding a collapsed rail brings the active chat back into view instead
  // of leaving the list scrolled wherever it happened to be.
  const recentListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (collapsed) return;
    recentListRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [collapsed]);

  const hideWhenCollapsed = collapsed ? "md:hidden" : "";
  const centerWhenCollapsed = collapsed ? "md:justify-center" : "";
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
                    ${collapsed ? "md:w-16" : "md:w-64"}
                    ${isOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="text-xl" aria-hidden>✨</span>
        <span className={`text-lg font-semibold text-neutral-700 ${hideWhenCollapsed}`}>Ari</span>
        <button
          aria-label="Close menu"
          onClick={onClose}
          className="ml-auto rounded-lg p-1 text-neutral-500 hover:bg-neutral-200/60 md:hidden"
        >
          ✕
        </button>
        <button
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleCollapsed}
          className="ml-auto hidden rounded-lg p-1 text-neutral-500 hover:bg-neutral-200/60 md:flex"
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>

      <div className="px-3">
        <button
          onClick={onNewChat}
          title="New chat"
          className={`flex w-full items-center gap-3 rounded-full bg-neutral-200/70 px-4 py-2.5
                     text-sm font-medium text-neutral-700 hover:bg-neutral-200 ${centerWhenCollapsed}`}
        >
          <span aria-hidden>✏️</span> <span className={hideWhenCollapsed}>New chat</span>
        </button>
      </div>

      <nav className="mt-2 px-3 text-sm text-neutral-600">
        <div className={hideWhenCollapsed}>
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
        </div>
        {/* "Game Stuff" gallery (PRD-3D-GAMES-AND-ASSETS §9b): the kid-facing
            asset library — discovery drives usage; an invisible library never
            gets asked for. */}
        <a
          href="/assets"
          title="Game Stuff"
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 hover:bg-neutral-200/60 ${centerWhenCollapsed}`}
        >
          <span aria-hidden>🧰</span> <span className={hideWhenCollapsed}>Game Stuff</span>
        </a>
        {/* No premium/upgrade tab here: plans are sold on ariantra.com, not in the
            kid UI (2026-07-11 pricing revamp). The upgrade route still exists for
            deep links. Guarded by sidebar-no-premium.test.ts. */}
        <a
          href="/parent"
          title="Parent area"
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 hover:bg-neutral-200/60 ${centerWhenCollapsed}`}
        >
          <span aria-hidden>🛡️</span> <span className={hideWhenCollapsed}>Parent area</span>
        </a>
        {/* /admin is OPERATOR tooling (ADMIN_SECRET) — not linked in kid UI. */}
      </nav>

      <div
        ref={recentListRef}
        className={`mt-4 min-h-0 flex-1 overflow-y-auto px-3 ${hideWhenCollapsed}`}
        onScroll={(e) => {
          // Infinite Recents: nearing the bottom pulls the next server page.
          const el = e.currentTarget;
          if (hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < 120) onEndReached?.();
        }}
      >
        <p className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
          {searchQuery.trim()
            ? `Recent — ${recents.length} ${recents.length === 1 ? "match" : "matches"}`
            : "Recent"}
        </p>
        <ul className="space-y-0.5">
          {recents.length === 0 && !recentsError && (
            <li className="px-3 py-2 text-xs text-neutral-400">
              {searchQuery.trim()
                ? "No chats found — try another word, or start a New chat."
                : "No chats yet"}
            </li>
          )}
          {recents.map((r) =>
            renamingId === r.id ? (
              <li key={r.id} className="flex items-center gap-1.5 rounded-lg bg-neutral-100 px-2 py-1.5">
                <input
                  autoFocus
                  value={renameDraft}
                  maxLength={200}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(r.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  aria-label={`New name for chat ${r.title}`}
                  className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-2 py-1 text-sm"
                />
                <button
                  onClick={() => commitRename(r.id)}
                  disabled={!renameDraft.trim()}
                  className="shrink-0 rounded-lg bg-neutral-800 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  onClick={() => setRenamingId(null)}
                  className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-200/60"
                >
                  Cancel
                </button>
              </li>
            ) : confirmingId === r.id ? (
              <li key={r.id} className="flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm text-red-700" title={r.title}>
                  Delete “{r.title}”?
                </span>
                <button
                  onClick={() => {
                    setConfirmingId(null);
                    onDelete(r.id);
                  }}
                  className="shrink-0 rounded-lg bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700"
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmingId(null)}
                  className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-200/60"
                >
                  Keep
                </button>
              </li>
            ) : (
              <li key={r.id} className="group relative flex items-center">
                <button
                  data-active={r.id === activeId}
                  onClick={() => {
                    closeSearch();
                    onSelect(r.id);
                  }}
                  className={`min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-left text-sm
                    ${r.id === activeId ? "bg-neutral-200 text-neutral-900" : "text-neutral-600 hover:bg-neutral-200/60"}`}
                  title={r.title}
                >
                  {r.pinnedAt != null && <span aria-label="Pinned" className="mr-1">📌</span>}
                  {r.title}
                  {r.sparks != null && r.sparks > 0 && (
                    <span className="ml-2 text-xs text-ink-500" aria-label={`${formatSparks(r.sparks)} Sparks used in this chat`}>
                      ⚡ {formatSparks(r.sparks)}
                    </span>
                  )}
                </button>
                {/* ⋮ menu (owner ask 2026-08-06, replaces the lone hover-✕):
                    Rename / Pin / Delete, like other chat apps. Keeps the
                    subtle hover-reveal (owner ask 2026-07-26) so rows stay
                    quiet until pointed at; keyboard-reachable via focus. */}
                <button
                  aria-label={`Chat options for ${r.title}`}
                  aria-haspopup="menu"
                  aria-expanded={menuId === r.id}
                  title="Chat options"
                  onClick={() => setMenuId(menuId === r.id ? null : r.id)}
                  className="shrink-0 rounded-lg px-2 py-2 text-sm text-neutral-400 opacity-0
                             hover:text-neutral-700 focus:opacity-100 group-hover:opacity-100"
                >
                  ⋮
                </button>
                {menuId === r.id && (
                  <>
                    {/* transparent backdrop: any outside tap closes the menu */}
                    <div className="fixed inset-0 z-20" onClick={() => setMenuId(null)} />
                    <div
                      role="menu"
                      onKeyDown={(e) => { if (e.key === "Escape") setMenuId(null); }}
                      className="absolute right-1 top-9 z-30 w-36 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg"
                    >
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenuId(null);
                          setRenameDraft(r.title);
                          setRenamingId(r.id);
                        }}
                        className="block w-full px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
                      >
                        ✏️ Rename
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenuId(null);
                          onTogglePin(r.id);
                        }}
                        className="block w-full px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
                      >
                        {r.pinnedAt != null ? "📌 Unpin" : "📌 Pin"}
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenuId(null);
                          onShare(r.id);
                        }}
                        className="block w-full px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
                      >
                        🔗 Share
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenuId(null);
                          setConfirmingId(r.id);
                        }}
                        className="block w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                      >
                        🗑️ Delete
                      </button>
                    </div>
                  </>
                )}
              </li>
            ),
          )}
          {hasMore && (
            <li>
              <button
                onClick={() => onEndReached?.()}
                className="w-full rounded-lg px-3 py-2 text-left text-xs text-neutral-400 hover:bg-neutral-200/60"
              >
                ⌄ Older chats…
              </button>
            </li>
          )}
          {recentsError && (
            <li>
              <button
                onClick={() => onRetryRecents?.()}
                className="w-full rounded-lg px-3 py-2 text-left text-xs text-amber-600 hover:bg-amber-50"
              >
                ⚠️ Couldn't load your chats — tap to retry
              </button>
            </li>
          )}
        </ul>
      </div>

      <div className="border-t border-neutral-200 px-3 py-3">
        {user ? (
          <div className={`flex items-center gap-3 ${centerWhenCollapsed}`}>
            {user.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.image} alt="" className="h-8 w-8 shrink-0 rounded-full" />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-700 text-sm text-white">
                {initial}
              </span>
            )}
            <div className={`min-w-0 text-sm leading-tight ${hideWhenCollapsed}`}>
              <p className="truncate font-medium text-neutral-700">{user.name ?? user.email}</p>
              <p className="text-xs text-neutral-400">Signed in</p>
            </div>
            <button
              onClick={() => signOut()}
              className={`ml-auto rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-200/60 ${hideWhenCollapsed}`}
            >
              Sign out
            </button>
          </div>
        ) : (
          <button
            onClick={() => signIn()}
            title="Sign in to Ariantra"
            className="flex w-full items-center justify-center gap-2 rounded-full border border-neutral-300
                       bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            <span aria-hidden>🔆</span> <span className={hideWhenCollapsed}>Sign in to Ariantra</span>
          </button>
        )}
      </div>
      </aside>
    </>
  );
}
