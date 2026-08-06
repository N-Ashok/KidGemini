// A revoked/unknown share link lands here — say what happened and what to do
// next (no dead-end errors), without confirming whether the chat ever existed.
export default function SharedChatNotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 text-center text-neutral-900">
      <div className="text-5xl">🔒</div>
      <h1 className="font-display mt-2 text-2xl font-bold">This shared chat isn&rsquo;t available</h1>
      <p className="mt-2 text-sm text-neutral-500">
        The link may have been turned off by the family who shared it. Ask them to send a fresh
        one — or come make your own game with Ari!
      </p>
      <a
        href="/"
        className="mt-5 rounded-2xl bg-orange-500 px-6 py-3 text-base font-extrabold text-white shadow-lg shadow-orange-500/30"
      >
        Try Ari →
      </a>
    </main>
  );
}
