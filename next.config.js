/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // better-sqlite3 is a native module — keep it external to the server bundle.
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
    // Enables src/instrumentation.ts's register() — stable by default in
    // Next 15, still opt-in on this 14.2.x. 2026-07-17: installs the
    // console-patching file logger + a process-level crash logger on every
    // server boot, instead of depending on chat/repair/safety routes being
    // the first thing hit.
    instrumentationHook: true,
  },
};

module.exports = nextConfig;
