"use client";
// Admin analytics — single-page dashboard: total token usage, estimated cost,
// per-user breakdown (who uses more/less), per-location (country/state/city/IP),
// and the raw request/output log over a configurable window (default 30 days).
// PIN-gated; reads /api/usage.

import { useState } from "react";
import type { UsageEvent, UsageSummary } from "@/types/usage.types";

interface UsageResponse {
  days: number;
  summary: UsageSummary;
  events?: UsageEvent[];
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export default function AdminPage() {
  const [pin, setPin] = useState("");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState("");

  async function load(e?: React.FormEvent) {
    e?.preventDefault();
    setError("");
    const res = await fetch(`/api/usage?pin=${encodeURIComponent(pin)}&days=${days}&detail=1`);
    if (!res.ok) {
      setError("Wrong PIN");
      return;
    }
    setData(await res.json());
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-sm p-8">
        <h1 className="mb-4 font-display text-2xl font-bold">Usage dashboard</h1>
        <form onSubmit={load} className="card space-y-4">
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="Parent PIN"
            className="w-full rounded-kid border-2 border-brand-100 px-4 py-3 text-lg"
          />
          {error && <p className="text-danger-600">{error}</p>}
          <button className="btn-primary w-full">View</button>
        </form>
      </main>
    );
  }

  const s = data.summary;
  return (
    <main className="mx-auto max-w-6xl space-y-8 p-8">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-3xl font-bold">Usage &amp; cost · last {data.days} days</h1>
        <form onSubmit={load} className="flex items-center gap-2">
          <input
            type="number"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-20 rounded-kid border-2 border-brand-100 px-3 py-2"
          />
          <button className="btn-ghost">Refresh</button>
        </form>
      </div>

      {/* Headline metrics */}
      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Requests" value={String(s.eventCount)} />
        <Stat label="Prompt tokens" value={s.totalPromptTokens.toLocaleString()} />
        <Stat label="Output tokens" value={s.totalOutputTokens.toLocaleString()} />
        <Stat label="Est. cost" value={usd(s.totalCostUsd)} />
      </section>

      {/* Per-day — how much each day, and who spent the most that day */}
      <Panel title="By day (newest first · top spender)">
        <Table
          head={["Day", "Requests", "Prompt tok", "Output tok", "Cost", "Top spender", "Their tokens"]}
          rows={s.byDay.map((d) => [
            d.day,
            String(d.eventCount),
            d.promptTokens.toLocaleString(),
            d.outputTokens.toLocaleString(),
            usd(d.costUsd),
            d.topUser ? (d.topUser.userLabel ?? d.topUser.userId) : "—",
            d.topUser ? d.topUser.tokens.toLocaleString() : "—",
          ])}
        />
      </Panel>

      {/* Per-user — who uses more / less */}
      <Panel title="By user (most → least cost)">
        <Table
          head={["User", "Requests", "Prompt tok", "Output tok", "Cost"]}
          rows={s.byUser.map((u) => [
            u.userLabel ?? u.userId,
            String(u.eventCount),
            u.promptTokens.toLocaleString(),
            u.outputTokens.toLocaleString(),
            usd(u.costUsd),
          ])}
        />
      </Panel>

      {/* Geo */}
      <Panel title="By location (country · state · city)">
        <Table
          head={["Country", "State/Region", "City", "Requests", "Cost"]}
          rows={s.byLocation.map((l) => [
            l.country ?? "—",
            l.region ?? "—",
            l.city ?? "—",
            String(l.eventCount),
            usd(l.costUsd),
          ])}
        />
      </Panel>

      {/* Raw request/output log */}
      <Panel title="Request log (request → output)">
        <Table
          head={["When", "User", "IP", "Model", "Kind", "Tok (in/out)", "Blocked", "Request", "Output"]}
          rows={(data.events ?? []).map((ev) => [
            new Date(ev.createdAt).toLocaleString(),
            ev.userLabel ?? ev.userId,
            ev.geo.ip ?? "—",
            ev.model,
            ev.kind,
            `${ev.promptTokens}/${ev.outputTokens}`,
            ev.blocked ? "yes" : "no",
            truncate(ev.requestText),
            truncate(ev.outputText),
          ])}
        />
      </Panel>
    </main>
  );
}

function truncate(t: string, n = 80): string {
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <p className="text-sm text-ink-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-ink-900">{value}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card overflow-x-auto">
      <h2 className="mb-3 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-brand-100 text-ink-500">
          {head.map((h) => (
            <th key={h} className="py-2 pr-4 font-semibold">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={head.length} className="py-4 text-ink-500">
              No data yet.
            </td>
          </tr>
        )}
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-brand-50">
            {r.map((c, j) => (
              <td key={j} className="py-2 pr-4 align-top text-ink-700">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
