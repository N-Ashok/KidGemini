// File logger. Tees all server console output to logs/app.log (and still prints to the
// terminal), so logs persist somewhere readable for monitoring. Server-only.
// Path is overridable via LOG_FILE; defaults to <project>/logs/app.log.

import "server-only";
import fs from "node:fs";
import path from "node:path";

const LOG_FILE = process.env.LOG_FILE || path.join(process.cwd(), "logs", "app.log");

function init(): fs.WriteStream {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  return fs.createWriteStream(LOG_FILE, { flags: "a" });
}

// Patch the global console exactly once per process so every console.* call across all
// modules is mirrored to the file with a timestamp + level.
const g = globalThis as unknown as { __kgLogPatched?: boolean; __kgLogStream?: fs.WriteStream };
if (!g.__kgLogPatched) {
  g.__kgLogPatched = true;
  const stream = init();
  g.__kgLogStream = stream;

  const fmt = (level: string, args: unknown[]) =>
    `[${new Date().toISOString()}] [${level}] ` +
    args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ") +
    "\n";

  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => { stream.write(fmt("INFO", a)); orig.log(...a); };
  console.warn = (...a: unknown[]) => { stream.write(fmt("WARN", a)); orig.warn(...a); };
  console.error = (...a: unknown[]) => { stream.write(fmt("ERROR", a)); orig.error(...a); };

  orig.log(`[logger] writing logs to ${LOG_FILE}`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const LOG_PATH = LOG_FILE;
