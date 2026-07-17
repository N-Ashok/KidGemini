"use client";
// Full-screen sign-in gate shown to unauthenticated visitors. Ari requires sign-in
// before any chat (the composer isn't rendered until authenticated), so this is the entry point
// rather than a reactive modal. Presentational: raises the sign-in intent via onSignIn.

interface SignInScreenProps {
  onSignIn: () => void;
}

export function SignInScreen({ onSignIn }: SignInScreenProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-white p-4 text-neutral-900">
      <div className="w-full max-w-sm rounded-kid bg-white p-8 text-center shadow-xl">
        <div className="text-5xl" aria-hidden>
          ✨
        </div>
        <h1 className="mt-4 text-2xl font-semibold text-neutral-800">Welcome to Ari</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Sign in to start chatting, ask questions, and make games. A grown-up keeps you safe. 🛡️
        </p>
        <button
          onClick={onSignIn}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-neutral-800
                     px-4 py-3 text-base font-medium text-white hover:bg-neutral-700"
        >
          <span aria-hidden>🔆</span> Sign in to Ariantra
        </button>
      </div>
    </div>
  );
}
