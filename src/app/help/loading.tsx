// Skeleton for /help — never a blank screen on a full-page nav (CLAUDE.md §5,
// the same rule the platform's loading.tsx files follow). Mirrors the gallery's
// real layout so the content lands where the placeholder was.

export default function HelpLoading() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="h-9 w-32 rounded-full bg-neutral-100" />
      <div className="mt-4 h-8 w-64 rounded-lg bg-neutral-100" />
      <div className="mt-2 h-5 w-80 max-w-full rounded-lg bg-neutral-100" />
      <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i} className="rounded-kid border border-neutral-200 bg-white p-4">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-xl bg-neutral-100" />
              <div className="h-5 w-40 rounded bg-neutral-100" />
            </div>
            <div className="mt-4 h-10 w-full rounded-full bg-neutral-100" />
          </li>
        ))}
      </ul>
    </main>
  );
}
