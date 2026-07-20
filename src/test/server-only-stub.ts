// No-op stand-in for Next's `server-only` package under vitest (node env).
//
// `server-only` throws at BUILD time if a module is pulled into a client
// bundle — the guard that keeps API keys and the safety gate server-side
// (CLAUDE.md §3). It has no runtime export, so importing it in a plain node
// test process fails to resolve. Aliasing it here keeps the real guard on in
// production builds while letting server modules be unit-tested directly.
export {};
