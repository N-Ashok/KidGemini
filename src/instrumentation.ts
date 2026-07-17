/**
 * Next.js instrumentation hook (requires experimental.instrumentationHook in
 * next.config.js on this 14.2.x — stable by default from Next 15). register()
 * runs once per server process, before any request is handled — for BOTH the
 * node and edge runtimes (Next builds both variants), so this file itself
 * must stay importable under either. Deliberately does NOT import
 * "@/lib/logger" here (2026-07-17, tried first): that module touches
 * node:fs/node:path directly, and even behind a runtime check webpack still
 * needs to COMPILE it for the edge variant, which fails outright — "Reading
 * from 'node:fs' is not handled" — a full build break, not a runtime issue.
 * The file logger stays opt-in per route (chat/repair/safety) as before;
 * this only adds the crash handler, via plain console.error (no fs import,
 * so it's edge-bundle-safe on its own).
 *
 * A process-level crash logger: previously nothing logged an unhandled
 * rejection or uncaught exception anywhere — a crash just looked like "pm2
 * restarted it," with no trail (the box was already observed restarting
 * 70x/8h with no logged reason). Log and keep running, matching the Platform
 * signaling process's same choice — a crash-and-restart drops every
 * in-flight request, which is worse than surviving one bad error in a
 * degraded-but-alive state.
 */
export async function register(): Promise<void> {
  // Only the Node runtime has `process.on`; the edge runtime doesn't.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  process.on("unhandledRejection", (reason) => {
    console.error("[process] unhandled rejection", reason instanceof Error ? reason.message : reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[process] uncaught exception", err.message, err.stack);
  });
}
