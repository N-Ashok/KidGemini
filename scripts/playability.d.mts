// Types for the shared playability helpers (scripts/playability.mjs). The
// module is plain .mjs because scripts/verify-game-html.mjs must import it at
// runtime under bare node, which cannot load TypeScript — one source of truth,
// no duplicated logic to drift.
export declare const IDLE_MARGIN: number;
export declare const MIN_CHANGED: number;
export declare function sampleDistance(a: readonly number[], b: readonly number[]): number;
export declare function judgePlayability(s: {
  idle: number;
  afterFirstInput: number;
  forwardVsBack: number;
}): { playable: boolean; reason?: string };
export declare function findFrozenStateRisks(source: string): string[];
