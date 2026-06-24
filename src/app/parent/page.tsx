"use client";
// Parent dashboard — PIN-gated alert log. Container-style page; presentational
// pieces stay simple. Real product would harden auth (session, hashed PIN).

import { useState } from "react";
import type { ParentAlert } from "@/types/alert.types";

export default function ParentPage() {
  const [pin, setPin] = useState("");
  const [alerts, setAlerts] = useState<ParentAlert[] | null>(null);
  const [error, setError] = useState("");

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await fetch(`/api/alerts?pin=${encodeURIComponent(pin)}`);
    if (!res.ok) {
      setError("Wrong PIN");
      return;
    }
    const data = await res.json();
    setAlerts(data.alerts);
  }

  const accent: Record<string, string> = {
    high: "border-danger-500",
    medium: "border-warn-500",
    low: "border-brand-300",
  };

  return (
    <main className="mx-auto max-w-3xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-3xl font-bold text-ink-900">Parent area</h1>
        <a href="/admin" className="text-sm text-brand-600 hover:underline">
          Usage &amp; cost dashboard →
        </a>
      </div>

      {!alerts ? (
        <form onSubmit={handleUnlock} className="card max-w-sm space-y-4">
          <label className="block text-lg font-semibold">Enter parent PIN</label>
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="w-full rounded-kid border-2 border-brand-100 px-4 py-3 text-lg"
            placeholder="••••"
          />
          {error && <p className="text-danger-600">{error}</p>}
          <button className="btn-primary w-full">Unlock</button>
        </form>
      ) : (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Safety alerts ({alerts.length})</h2>
          {alerts.length === 0 && <p className="text-ink-500">No alerts yet. 🎉</p>}
          {alerts.map((a) => (
            <article
              key={a.id}
              className={`card border-l-4 ${accent[a.severity] ?? "border-brand-300"}`}
            >
              <div className="flex items-center justify-between text-sm text-ink-500">
                <span>
                  {a.severity.toUpperCase()} · {a.category ?? "general"} · from {a.origin}
                </span>
                <time>{new Date(a.createdAt).toLocaleString()}</time>
              </div>
              <p className="mt-2 font-medium text-ink-900">“{a.triggerText}”</p>
              <p className="mt-1 text-ink-700">{a.reason}</p>
              <p className="mt-1 text-sm text-ink-500">Action: {a.action}</p>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
