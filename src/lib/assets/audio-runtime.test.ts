// Audio runtime (docs/2026-08-29_PRD_Audio.md §4 Phase 3). Executable, not
// string pins: playSound's pitch jitter and burst guard are the two fixes the
// PROMPT cannot make, and a typo in either ships silence or clipping to every
// game — the runtime is injected at delivery, so this also retro-fits games
// that already exist.
import { describe, it, expect } from "vitest";
import { audioHelper } from "./runtime-helpers";

/** Run the injected audio script against a fake window + fake WebAudio,
 *  recording every buffer source it creates. */
function bootAudio() {
  const sources: { playbackRate: { value: number }; started: number[] }[] = [];
  const gains: { gain: { value: number } }[] = [];
  const makeSource = () => {
    const s = { playbackRate: { value: 1 }, buffer: null as unknown, loop: false, loopStart: 0, loopEnd: 0, started: [] as number[], connect() {}, start(...a: number[]) { s.started.push(a[0] ?? 0); }, stop() {} };
    sources.push(s as never);
    return s;
  };
  const buf = { duration: 1, sampleRate: 44100, getChannelData: () => new Float32Array([0.5, 0.5, 0.5]) };
  const ctx = {
    state: "running",
    destination: {},
    createBufferSource: makeSource,
    createGain: () => { const g = { gain: { value: 1 }, connect() {} }; gains.push(g as never); return g; },
    resume() {},
    // real signature: decodeAudioData(arrayBuffer, onSuccess, onError)
    decodeAudioData: (_ab: unknown, ok: (b: unknown) => void) => ok(buf),
  };
  const win: Record<string, unknown> = {
    AudioContext: function () { return ctx; } as unknown,
    AR_ASSETS: { jump: "https://x/jump.mp3", coin_pickup: "https://x/coin.mp3", bg_loop_upbeat: "https://x/bg.mp3" },
    performance: { now: () => Date.now() },
  };
  const fetchStub = () => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
  const body = audioHelper().replace(/^<script>/, "").replace(/<\/script>$/, "");
  new Function("window", "fetch", "addEventListener", "console", `${body}`)(
    win, fetchStub, () => {}, { warn() {}, log() {} },
  );
  return { win, sources, gains };
}

// two microtask hops: fetch → arrayBuffer → decodeAudioData
const flush = () => new Promise((r) => setTimeout(r, 5));

describe("playSound — variation and burst guard (PRD-Audio Phase 3)", () => {
  it("AR.1 still accepts the old one-argument call — every existing game keeps working", async () => {
    const { win } = bootAudio();
    expect(() => (win.playSound as (n: string) => void)("jump")).not.toThrow();
  });

  it("AR.2 jitters pitch on repeat plays, within ±10% — one file must not sound identical 200 times", async () => {
    const { win, sources } = bootAudio();
    const play = win.playSound as (n: string, o?: unknown) => void;
    for (let i = 0; i < 6; i++) { play("jump", { minInterval: 0 }); await flush(); }
    const rates = sources.map((s) => s.playbackRate.value);
    expect(rates.length).toBeGreaterThanOrEqual(5);
    expect(new Set(rates).size).toBeGreaterThan(1);               // not all identical
    for (const r of rates) { expect(r).toBeGreaterThanOrEqual(0.9); expect(r).toBeLessThanOrEqual(1.1); }
  });

  it("AR.3 an explicit pitch wins over the jitter (a game that wants a rising pitch can have one)", async () => {
    const { win, sources } = bootAudio();
    (win.playSound as (n: string, o: unknown) => void)("jump", { pitch: 1.5, minInterval: 0 });
    await flush();
    expect(sources.at(-1)!.playbackRate.value).toBeCloseTo(1.5, 5);
  });

  it("AR.4 a burst of the SAME sound in one frame plays once — ten collisions must not stack into clipping", async () => {
    const { win, sources } = bootAudio();
    const play = win.playSound as (n: string, o?: unknown) => void;
    for (let i = 0; i < 10; i++) play("jump");
    await flush();
    expect(sources.length).toBe(1);
  });

  it("AR.5 different sounds in the same frame all play — the guard is per sound, not global", async () => {
    const { win, sources } = bootAudio();
    const play = win.playSound as (n: string, o?: unknown) => void;
    play("jump"); play("coin_pickup");
    await flush();
    expect(sources.length).toBe(2);
  });

  it("AR.6 volume rides a gain node; an unknown sound stays silent and never throws", async () => {
    const { win, gains } = bootAudio();
    (win.playSound as (n: string, o: unknown) => void)("jump", { volume: 0.25, minInterval: 0 });
    await flush();
    expect(gains.some((g) => Math.abs(g.gain.value - 0.25) < 1e-6)).toBe(true);
    expect(() => (win.playSound as (n: string) => void)("no_such_sound")).not.toThrow();
  });
});
