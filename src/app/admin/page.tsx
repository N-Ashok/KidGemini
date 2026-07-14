"use client";
// Admin analytics — single-page dashboard: total token usage, estimated cost,
// per-user breakdown (who uses more/less), per-location (country/state/city/IP),
// and the raw request/output log over a configurable window (default 30 days).
// PIN-gated; reads /api/usage.

import { useState } from "react";
import type { PeriodTotals, RepeatUser, UniqueCounts, UsageEvent, UsageSummary } from "@/types/usage.types";

type PeriodWithInr = PeriodTotals & { costInr: number };
type PeriodKey = "today" | "thisWeek" | "thisMonth" | "thisYear" | "allTime";

interface UsageResponse {
  days: number;
  inrPerUsd: number;
  periods: Record<PeriodKey, PeriodWithInr>;
  uniques: Record<PeriodKey, UniqueCounts>;
  repeatUsers: RepeatUser[];
  summary: UsageSummary;
  events?: UsageEvent[];
}

const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "Today",
  thisWeek: "This week",
  thisMonth: "This month",
  thisYear: "This year",
  allTime: "All time",
};

/** Best estimate of distinct people: accounts + the smaller of the two guest
 *  signals (cookie count inflates on cookie clears; device count deflates on
 *  shared wifi + same browser — the min is the sturdier guess). */
function estUnique(u: UniqueCounts): number {
  return u.signedInUsers + Math.min(u.guestBrowsers, u.guestDevices);
}

/** Coarse "Chrome · Windows" label from a raw User-Agent (display only). */
function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return "—";
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\//.test(ua) ? "Opera" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" :
    /Firefox\//.test(ua) ? "Firefox" : "Other";
  const os =
    /Windows/.test(ua) ? "Windows" :
    /iPhone|iPad|iPod/.test(ua) ? "iOS" :
    /Android/.test(ua) ? "Android" :
    /Mac OS X/.test(ua) ? "macOS" :
    /Linux/.test(ua) ? "Linux" : "?";
  return `${browser} · ${os}`;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function inr(n: number): string {
  return `₹${n.toFixed(2)}`;
}

function tok(n: number): string {
  return n.toLocaleString();
}

export default function AdminPage() {
  // OPERATOR tooling — ADMIN_SECRET, nothing to do with the parent PIN
  // (PRD-PARENT-AUTH-ALERT-SCOPING D2). POST body so the secret never lands
  // in access logs or browser history.
  const [secret, setSecret] = useState("");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState("");

  async function load(e?: React.FormEvent) {
    e?.preventDefault();
    setError("");
    const res = await fetch("/api/usage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, days, detail: true }),
    });
    if (!res.ok) {
      setError(
        res.status === 503
          ? "ADMIN_SECRET isn't configured on the server — the dashboard is offline."
          : "Wrong admin secret.",
      );
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
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Admin secret"
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

      {/* Rollups — today first (IST day), then week/month/year/all-time.
          All 4 billed token types; ₹ primary, $ secondary. */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <PeriodCard label="Today" p={data.periods.today} highlight />
        <PeriodCard label="This week" p={data.periods.thisWeek} />
        <PeriodCard label="This month" p={data.periods.thisMonth} />
        <PeriodCard label="This year" p={data.periods.thisYear} />
        <PeriodCard label="All time" p={data.periods.allTime} />
      </section>
      <p className="text-sm text-ink-500">
        ₹ at {inr(data.inrPerUsd)}/USD (set USD_INR_RATE to update). Prompt includes cached;
        thinking bills at the output rate.
      </p>

      {/* Unique visitors — accounts vs guest cookies vs guest devices */}
      <Panel title="Unique visitors">
        <Table
          head={["Period", "Signed-in accounts", "Guest browsers (cookies)", "Guest devices (IP + browser)", "Est. unique people"]}
          rows={(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => [
            PERIOD_LABELS[k],
            tok(data.uniques[k].signedInUsers),
            tok(data.uniques[k].guestBrowsers),
            tok(data.uniques[k].guestDevices),
            tok(estUnique(data.uniques[k])),
          ])}
        />
        <p className="mt-3 text-sm text-ink-500">
          Guests can&apos;t be counted exactly: clearing cookies makes one browser look new
          (inflates &ldquo;browsers&rdquo;), while shared wifi with the same browser type merges kids
          (deflates &ldquo;devices&rdquo;). The estimate takes accounts + the smaller guest signal.
          A guest who later signs in is counted once in each column, so don&apos;t sum them.
        </p>
      </Panel>

      {/* Returning users — accounts and guest cookies seen on 2+ IST days */}
      <Panel title="Returning users (active on 2+ days, all time)">
        <Table
          head={["User", "Type", "Days active", "Requests", "First seen", "Last seen"]}
          rows={data.repeatUsers.map((r) => [
            r.userLabel ?? r.userId,
            r.userId.startsWith("user:") ? "Account" : "Guest",
            String(r.activeDays),
            String(r.eventCount),
            new Date(r.firstSeen).toLocaleDateString(),
            new Date(r.lastSeen).toLocaleDateString(),
          ])}
        />
        <p className="mt-3 text-sm text-ink-500">
          Several visits on the same day count as one active day — this list is about coming
          back, not volume. A guest who clears cookies (or switches browsers) starts over as
          a new guest, so guest streaks are an undercount.
        </p>
      </Panel>

      {/* Per-day — how much each day, and who spent the most that day */}
      <Panel title="By day (newest first · top spender)">
        <Table
          head={["Day", "Requests", "Prompt tok", "Output tok", "Thinking tok", "Cached tok", "Cost ₹", "Cost $", "Top spender", "Their tokens"]}
          rows={s.byDay.map((d) => [
            d.day,
            String(d.eventCount),
            tok(d.promptTokens),
            tok(d.outputTokens),
            tok(d.thoughtTokens),
            tok(d.cachedTokens),
            inr(d.costUsd * data.inrPerUsd),
            usd(d.costUsd),
            d.topUser ? (d.topUser.userLabel ?? d.topUser.userId) : "—",
            d.topUser ? tok(d.topUser.tokens) : "—",
          ])}
        />
      </Panel>

      {/* Per-user — who uses more / less */}
      <Panel title="By user (most → least cost)">
        <Table
          head={["User", "Requests", "Prompt tok", "Output tok", "Thinking tok", "Cached tok", "Cost ₹", "Cost $"]}
          rows={s.byUser.map((u) => [
            u.userLabel ?? u.userId,
            String(u.eventCount),
            tok(u.promptTokens),
            tok(u.outputTokens),
            tok(u.thoughtTokens),
            tok(u.cachedTokens),
            inr(u.costUsd * data.inrPerUsd),
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
          head={["When", "User", "IP", "Device", "Model", "Kind", "Tok (in/out/think/cache)", "Blocked", "Request", "Output"]}
          rows={(data.events ?? []).map((ev) => [
            new Date(ev.createdAt).toLocaleString(),
            ev.userLabel ?? ev.userId,
            ev.geo.ip ?? "—",
            deviceLabel(ev.userAgent),
            ev.model,
            ev.kind,
            `${ev.billedPromptTokens ?? ev.promptTokens}/${ev.billedOutputTokens ?? ev.outputTokens}/${ev.thoughtTokens ?? 0}/${ev.cachedTokens ?? 0}`,
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

/** One rollup window: requests, all 4 billed token types, ₹ primary + $ secondary. */
function PeriodCard({ label, p, highlight }: { label: string; p: PeriodWithInr; highlight?: boolean }) {
  return (
    <div className={`card ${highlight ? "border-2 border-brand-100" : ""}`}>
      <p className="text-sm font-semibold text-ink-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-ink-900">{inr(p.costInr)}</p>
      <p className="text-xs text-ink-500">{usd(p.costUsd)} · {p.eventCount} requests</p>
      <dl className="mt-3 space-y-1 text-sm text-ink-700">
        <Row k="Prompt" v={tok(p.promptTokens)} />
        <Row k="Output" v={tok(p.outputTokens)} />
        <Row k="Thinking" v={tok(p.thoughtTokens)} />
        <Row k="Cached" v={tok(p.cachedTokens)} />
        <Row k="Total" v={tok(p.promptTokens + p.outputTokens + p.thoughtTokens)} />
      </dl>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-500">{k}</dt>
      <dd className="font-semibold">{v}</dd>
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
