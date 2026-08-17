// Structured, correlated logging for one unit of work — a chat turn, a repair,
// a publish (owner ask 2026-08-17: "i need log system proper in all the code so
// when it fails, i will know where to look for").
//
// WHAT WAS WRONG. There was never a shortage of log LINES — 161 console calls
// across the API and lib. What was missing was the ability to answer three
// questions from them:
//
//  1. "Which turn was that?" Nothing tied a line to the request that produced
//     it. During the 2026-08-17 investigation, a chat turn was matched to its
//     repair BY EYE, comparing character counts across timestamps. That works
//     with one owner on the box and becomes guesswork with ten children.
//  2. "How far did it get?" Lines announced outcomes ("✓ edit patch") without
//     a vocabulary of STAGES, so a turn that died between two of them left a
//     gap you had to already know the pipeline to notice.
//  3. "What actually broke?" Values were interpolated into prose, so nothing
//     was greppable or countable. The worst case shipped as
//     `err="[object Object]"` for every error it caught (BUG_LOG 2026-08-17)
//     — an instrument built to make faults countable that could not name one.
//
// THE SHAPE. One line per event, `key=value` pairs after a stable prefix:
//
//   [api/chat] trace=k3f9a2xr stage=patch outcome=ok ms=1841 chars=60543
//   [api/chat] trace=k3f9a2xr stage=lint outcome=fail ms=71804 bad=loadModel,placeModel
//
// so `grep trace=k3f9a2xr app.log` is the whole story of one turn, in order,
// and `grep 'stage=lint outcome=fail' | wc -l` is a rate. Both are things
// nobody could do before.
//
// PRIVACY IS PART OF THE FORMAT, not a convention on top of it. These logs
// describe children's sessions. A field value is NEVER free text from a child
// or from a model: log lengths, codes, counts, names from our own manifest.
// `chars=` not the message; `code=start_occluded` not the console output.
// The one deliberate exception is JS error text from generated code, which is
// our own model's output about our own runtime — and it goes through
// formatRepairErrorSummary, which truncates it.
//
// It writes through `console.*`, so logger.ts keeps teeing everything to
// logs/app.log with timestamps and levels exactly as before. This module adds
// structure, not a second transport.

/** Characters used for trace ids: unambiguous in a terminal (no 0/O, 1/l). */
const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/**
 * A short id for one unit of work. 8 characters of this alphabet is ~39 bits —
 * far more than enough to keep a day's turns distinct in a log file, and short
 * enough to read out loud and to paste into a grep.
 *
 * Deliberately NOT a uuid: this is a grep key a human types, and 36 characters
 * of hex is hostile to that. Deliberately not sequential either — that would
 * need shared state, and two pm2 processes would collide.
 */
export function newTraceId(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return out;
}

/** A trace id that arrived from a client, accepted only if it looks like one
 *  we issued. Fail-closed on shape (never on the request): anything else gets
 *  a fresh id, so a malformed or hostile value can neither poison the log
 *  format nor smuggle text into it. */
export function adoptTraceId(candidate: unknown): string {
  return typeof candidate === "string" && /^[2-9a-z]{8}$/.test(candidate)
    ? candidate
    : newTraceId();
}

export type Outcome = "ok" | "warn" | "fail" | "skip";

/** Field values we accept. Objects are not accepted BY DESIGN — that is the
 *  `[object Object]` bug, made unrepresentable. */
export type LogValue = string | number | boolean | null | undefined;

/**
 * Renders one field value safely:
 *  - collapses whitespace, so one event is always exactly one line;
 *  - quotes anything containing a space or `=`, so `key=val` stays parseable;
 *  - truncates at 200 characters, so a runaway string cannot flood the file;
 *  - drops undefined/null entirely at the call site (see `fields`).
 */
export function formatValue(value: LogValue): string {
  const raw = String(value).replace(/\s+/g, " ").trim();
  const clipped = raw.length > 200 ? `${raw.slice(0, 197)}...` : raw;
  return /[\s="]/.test(clipped) ? `"${clipped.replace(/"/g, "'")}"` : clipped;
}

/** Renders a field bag to ` k=v k=v`. Undefined and null fields are OMITTED
 *  rather than printed as "undefined" — an absent field should look absent,
 *  and half the value of these lines is being able to grep for a field's
 *  presence. */
export function formatFields(fields: Record<string, LogValue> = {}): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}=${formatValue(v)}`)
    .join("");
}

/**
 * The logger for one unit of work.
 *
 * Every method returns void and NOTHING here throws: a logging bug must never
 * be able to fail a child's game. Each call is wrapped, and a failure inside
 * the formatter degrades to a bare line rather than an exception escaping into
 * the request path.
 */
export class TurnLog {
  readonly trace: string;
  private readonly surface: string;
  private readonly base: Record<string, LogValue>;
  private readonly t0: number;

  /**
   * @param surface  the log prefix, e.g. "api/chat" — matches the existing
   *                 `[api/chat]` convention so old and new lines interleave
   *                 readably in the same file.
   * @param trace    an existing trace id to continue (a repair continuing its
   *                 chat turn), or omitted to start a new one.
   * @param base     fields repeated on EVERY line of this unit — userId, kind.
   */
  constructor(surface: string, trace?: string, base: Record<string, LogValue> = {}) {
    this.surface = surface;
    this.trace = trace ?? newTraceId();
    this.base = base;
    this.t0 = Date.now();
  }

  /** Milliseconds since this unit of work started. */
  elapsed(): number {
    return Date.now() - this.t0;
  }

  /**
   * One event. `stage` names WHERE in the pipeline we are — the vocabulary
   * that lets a gap in the log be read as a stage that never completed.
   *
   * Level follows outcome so the existing logger.ts INFO/WARN/ERROR tagging
   * stays meaningful: `fail` goes to console.error, `warn`/`skip` to
   * console.warn, `ok` to console.log.
   */
  event(stage: string, outcome: Outcome, fields: Record<string, LogValue> = {}): void {
    try {
      const line =
        `[${this.surface}] trace=${this.trace} stage=${stage} outcome=${outcome} ms=${this.elapsed()}` +
        formatFields({ ...this.base, ...fields });
      if (outcome === "fail") console.error(line);
      else if (outcome === "ok") console.log(line);
      else console.warn(line);
    } catch {
      // A logging failure must never become a request failure.
      try {
        console.warn(`[${this.surface}] trace=${this.trace} stage=${stage} outcome=log_error`);
      } catch {
        /* give up silently — there is nowhere left to report to */
      }
    }
  }

  ok(stage: string, fields?: Record<string, LogValue>): void {
    this.event(stage, "ok", fields);
  }
  warn(stage: string, fields?: Record<string, LogValue>): void {
    this.event(stage, "warn", fields);
  }
  /** Something did not happen that could have — a rung not taken, a gate that
   *  declined. Distinct from `warn` so "we chose not to" is greppable apart
   *  from "it went wrong". */
  skip(stage: string, fields?: Record<string, LogValue>): void {
    this.event(stage, "skip", fields);
  }

  /**
   * A failure, with the error rendered rather than interpolated.
   *
   * `err` is `unknown` on purpose: that is what a `catch` binding is, and
   * every previous version of this pattern in the codebase interpolated it
   * directly with `String(err)` — which is exactly how `err="[object Object]"`
   * shipped to production. Here the unwrapping happens ONCE, correctly.
   */
  fail(stage: string, err?: unknown, fields?: Record<string, LogValue>): void {
    this.event(stage, "fail", { ...fields, err: describeError(err) });
  }
}

/** Turns anything a `catch` can bind into one short readable string.
 *
 *  The whole point of this function existing: `String(err)` on a plain object
 *  yields "[object Object]", and the codebase shipped that to production as
 *  its only record of what broke (BUG_LOG 2026-08-17). Every shape is handled
 *  explicitly, and the result is always non-empty so a failure never logs a
 *  blank cause. */
export function describeError(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) return err.message || err.name || "Error";
  if (typeof err === "string") return err || "(empty)";
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  try {
    const json = JSON.stringify(err);
    // JSON.stringify returns undefined for functions/symbols, and "{}" for an
    // object with no own enumerable properties — neither tells anyone
    // anything, so name the shape instead.
    if (json && json !== "{}") return json;
  } catch {
    /* circular, or a throwing getter — fall through to the shape tag */
  }
  return shapeTag(err);
}

/** Last resort: name the shape. Never returns the literal "[object Object]" —
 *  that string is the bug this module exists to prevent, and a reader who sees
 *  it learns nothing, so an anonymous object is reported as such. */
function shapeTag(err: unknown): string {
  let tag = "[object Object]";
  try {
    tag = Object.prototype.toString.call(err);
  } catch {
    /* keep the default */
  }
  if (tag !== "[object Object]") return tag;
  try {
    const keys = Object.keys(err as object);
    if (keys.length) return `object(${keys.slice(0, 8).join(",")})`;
  } catch {
    /* not key-enumerable */
  }
  return "object(no readable properties)";
}
