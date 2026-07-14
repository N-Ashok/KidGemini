"use client";
// The sign-in wall shown when a guest hits the free-token limit. Presentational only:
// it renders the prompt and raises onSignIn — the container decides what signing in means.

interface LoginGateProps {
  message: string;
  onSignIn: () => void;
  /** Paywall variant — show an (placeholder) Upgrade option alongside sign-in. */
  showUpgrade?: boolean;
}

export function LoginGate({ message, onSignIn, showUpgrade = false }: LoginGateProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4">
      <div className="w-full max-w-sm rounded-kid bg-white p-6 text-center shadow-xl">
        <div className="text-4xl" aria-hidden>{showUpgrade ? "💳" : "✨"}</div>
        <h2 className="mt-3 text-lg font-semibold text-neutral-800">Keep the fun going!</h2>
        <p className="mt-2 text-sm text-neutral-600">{message}</p>
        {showUpgrade && (
          <button
            disabled
            title="Payments coming soon"
            className="mt-5 w-full cursor-not-allowed rounded-full bg-brand-500/90 px-4 py-3 text-sm
                       font-medium text-white opacity-70"
          >
            ⭐ Upgrade — coming soon
          </button>
        )}
        <button
          onClick={onSignIn}
          className={`flex w-full items-center justify-center gap-3 rounded-full border border-neutral-300
                     bg-white px-4 py-3 text-sm font-medium text-neutral-700 hover:bg-neutral-50
                     ${showUpgrade ? "mt-3" : "mt-5"}`}
        >
          <span aria-hidden>🔆</span> Sign in to continue
        </button>
      </div>
    </div>
  );
}
