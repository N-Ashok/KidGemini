import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TurnLog,
  newTraceId,
  adoptTraceId,
  describeError,
  formatValue,
  formatFields,
} from "./turn-log";

// The logging system's own tests. It exists so that when something fails in
// production the owner can find WHERE — so the properties worth pinning are
// the ones that make a log file answerable: one line per event, a greppable
// trace key, parseable fields, no free text from a child, and no way for a
// logging bug to break a request.

let logged: string[];
let warned: string[];
let errored: string[];
let spies: Array<{ mockRestore: () => void }>;

beforeEach(() => {
  logged = [];
  warned = [];
  errored = [];
  spies = [
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.join(" "))),
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warned.push(a.join(" "))),
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errored.push(a.join(" "))),
  ];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

describe("trace ids — the grep key", () => {
  it("L.1 is short, lowercase and free of look-alike characters", () => {
    // It gets typed into a grep and read off a screen; 0/O and 1/l would make
    // that unreliable, and a 36-char uuid would make it unpleasant.
    for (let i = 0; i < 200; i++) {
      const id = newTraceId();
      expect(id).toMatch(/^[2-9a-z]{8}$/);
      expect(id).not.toMatch(/[01ilo]/);
    }
  });

  it("L.2 does not collide across a realistic day's volume", () => {
    const ids = new Set(Array.from({ length: 20_000 }, newTraceId));
    expect(ids.size).toBe(20_000);
  });

  it("L.3 adopts a well-formed client id so a repair joins its chat turn", () => {
    expect(adoptTraceId("k3f9a2xr")).toBe("k3f9a2xr");
  });

  it("L.4 REFUSES anything else, rather than letting it into the log format", () => {
    // Fail-closed on shape: a hostile value must not be able to inject spaces,
    // newlines or `key=value` pairs into a line, nor smuggle child text in.
    for (const bad of [
      "",
      "short",
      "way-too-long-to-be-ours",
      "K3F9A2XR", // wrong case
      "k3f9a2x ", // trailing space
      "aaaa=bbb",
      "k3f9\na2x",
      "0illegal",
      42,
      null,
      undefined,
      { toString: () => "k3f9a2xr" },
    ]) {
      const got = adoptTraceId(bad);
      expect(got).toMatch(/^[2-9a-z]{8}$/);
      expect(got).not.toBe(bad);
    }
  });
});

describe("field formatting — the log must stay parseable and bounded", () => {
  it("L.5 keeps one event on ONE line, whatever the value contains", () => {
    // A multi-line value would break both `grep trace=` (which reports lines)
    // and any future line-oriented parse.
    expect(formatValue("a\nb\r\nc")).not.toMatch(/[\r\n]/);
    expect(formatFields({ a: "x\ny" })).not.toMatch(/[\r\n]/);
  });

  it("L.6 quotes values containing a space or =, so key=value survives", () => {
    expect(formatValue("two words")).toBe('"two words"');
    expect(formatValue("a=b")).toBe('"a=b"');
    expect(formatValue("plain")).toBe("plain");
  });

  it("L.7 truncates a runaway value instead of flooding the file", () => {
    // The log file has a 10MB rotation ceiling on a 1GB box (logger.ts) — one
    // unbounded value could consume it.
    const out = formatValue("x".repeat(5_000));
    expect(out.length).toBeLessThanOrEqual(202);
    expect(out).toMatch(/\.\.\.$/);
  });

  it("L.8 OMITS absent fields rather than printing 'undefined'", () => {
    // Half the value of these lines is grepping for a field's presence; an
    // `err=undefined` on every healthy line destroys that.
    expect(formatFields({ a: 1, b: undefined, c: null, d: 0, e: false })).toBe(" a=1 d=0 e=false");
  });
});

describe("TurnLog — the event line", () => {
  it("L.9 carries surface, trace, stage, outcome and elapsed ms, in that order", () => {
    const log = new TurnLog("api/chat", "k3f9a2xr");
    log.ok("patch", { chars: 60_543 });
    expect(logged[0]).toMatch(
      /^\[api\/chat\] trace=k3f9a2xr stage=patch outcome=ok ms=\d+ chars=60543$/,
    );
  });

  it("L.10 repeats the base fields on every line of the unit", () => {
    // So a grep on `trace=` gives self-contained lines — you never have to
    // scroll back to find out whose turn this was.
    const log = new TurnLog("api/chat", "k3f9a2xr", { userId: "guest:abc", kind: "edit" });
    log.ok("start");
    log.ok("deliver");
    expect(logged[0]).toContain("userId=guest:abc");
    expect(logged[1]).toContain("kind=edit");
  });

  it("L.11 routes by outcome so INFO/WARN/ERROR stay meaningful in app.log", () => {
    const log = new TurnLog("api/chat", "k3f9a2xr");
    log.ok("a");
    log.warn("b");
    log.skip("c");
    log.fail("d", new Error("boom"));
    expect(logged).toHaveLength(1);
    expect(warned).toHaveLength(2); // warn + skip
    expect(errored).toHaveLength(1);
    expect(errored[0]).toContain("outcome=fail");
    expect(errored[0]).toContain("err=boom");
  });

  it("L.12 distinguishes 'we chose not to' (skip) from 'it went wrong' (warn)", () => {
    const log = new TurnLog("api/chat", "k3f9a2xr");
    log.skip("rung", { why: "no_patch" });
    expect(warned[0]).toContain("outcome=skip");
  });
});

describe("describeError — the [object Object] bug, made unrepresentable", () => {
  // The whole reason this function exists. `String(err)` on a plain object is
  // "[object Object]", and that shipped to production as the only record of
  // what broke: an instrument built to make generation faults countable that
  // could not name a single one (BUG_LOG 2026-08-17).
  it("L.13 never returns [object Object] for any shape a catch can bind", () => {
    const shapes: unknown[] = [
      new Error("boom"),
      new TypeError("bad type"),
      "a string",
      42,
      false,
      { code: "ECONN", detail: "refused" },
      [1, 2, 3],
      { nested: { deep: true } },
      Object.create(null),
      new Error(""), // an Error with no message
    ];
    shapes.forEach((s, i) => {
      // NOTE: `String(s)` cannot be used to label this assertion — one of the
      // shapes is Object.create(null), and stringifying it throws. That is the
      // same class of trap as the bug under test, so the label uses the index.
      const out = describeError(s);
      expect(out, `shape #${i} produced nothing`).toBeTruthy();
      expect(out, `shape #${i} came back as the useless default`).not.toBe("[object Object]");
    });
  });

  it("L.14 keeps a plain object's actual contents, which is the useful part", () => {
    expect(describeError({ code: "ECONN", detail: "refused" })).toContain("ECONN");
  });

  it("L.15 survives a circular object rather than throwing inside a catch block", () => {
    // This runs INSIDE error handling. Throwing here would replace a
    // recoverable failure with an unrecoverable one.
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
    expect(describeError(circular)).toBeTruthy();
  });

  it("L.16 reports absent as absent (no err= field on a clean line)", () => {
    expect(describeError(undefined)).toBeUndefined();
    expect(describeError(null)).toBeUndefined();
  });
});

describe("a logging bug must never break a child's game", () => {
  it("L.17 swallows a console that throws", () => {
    (console.log as unknown as { mockImplementation: (f: () => void) => void }).mockImplementation(
      () => {
        throw new Error("stream closed");
      },
    );
    const log = new TurnLog("api/chat", "k3f9a2xr");
    expect(() => log.ok("patch")).not.toThrow();
  });

  it("L.18 survives a value whose toString throws", () => {
    const hostile = {
      toString() {
        throw new Error("nope");
      },
    };
    const log = new TurnLog("api/chat", "k3f9a2xr");
    expect(() => log.ok("patch", { bad: hostile as unknown as string })).not.toThrow();
  });
});
