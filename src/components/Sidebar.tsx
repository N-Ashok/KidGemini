"use client";
// Gemini-style left sidebar: brand, New chat, search, recent conversations, profile.
// Presentational; raises events via props. Recents are passed in by the container.

interface RecentItem {
  id: string;
  title: string;
}

interface SidebarProps {
  recents: RecentItem[];
  activeId: string | null;
  onNewChat: () => void;
  onSelect: (id: string) => void;
}

export function Sidebar({ recents, activeId, onNewChat, onSelect }: SidebarProps) {
  return (
    <aside className="flex h-screen w-64 flex-col border-r border-neutral-200 bg-neutral-50">
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="text-xl" aria-hidden>✨</span>
        <span className="text-lg font-semibold text-neutral-700">KidGemini</span>
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
        <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2 hover:bg-neutral-200/60">
          <span aria-hidden>🔍</span> Search chats
        </button>
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
          Recent
        </p>
        <ul className="space-y-0.5">
          {recents.length === 0 && (
            <li className="px-3 py-2 text-xs text-neutral-400">No chats yet</li>
          )}
          {recents.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => onSelect(r.id)}
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

      <div className="flex items-center gap-3 border-t border-neutral-200 px-4 py-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-700 text-sm text-white">
          A
        </span>
        <div className="text-sm leading-tight">
          <p className="font-medium text-neutral-700">Ashok N</p>
          <p className="text-xs text-neutral-400">Family</p>
        </div>
      </div>
    </aside>
  );
}
