// File logger. Tees all server console output to logs/app.log (and still prints to the
// terminal), so logs persist somewhere readable for monitoring. Server-only.
// Path is overridable via LOG_FILE; defaults to <project>/logs/app.log.

import "server-only";
import fs from "node:fs";
import path from "node:path";
import { rotateIfNeeded } from "./log-rotate";

const LOG_FILE = process.env.LOG_FILE || path.join(process.cwd(), "logs", "app.log");
// 10MB ceiling (2026-07-17): the file was previously unbounded on a box that
// already pm2-restarts kidgemini at a 350MB memory ceiling out of 908MB total
// — disk pressure is exactly the kind of failure the app's unguarded SQLite
// writes are least prepared for.
const MAX_LOG_BYTES = 10 * 1024 * 1024;

function openStream(): fs.WriteStream {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  return fs.createWriteStream(LOG_FILE, { flags: "a" });
}

// Patch the global console exactly once per process so every console.* call across all
// modules is mirrored to the file with a timestamp + level.
const g = globalThis as unknown as { __kgLogPatched?: boolean; __kgLogStream?: fs.WriteStream };
if (!g.__kgLogPatched) {
  g.__kgLogPatched = true;
  let stream = openStream();
  g.__kgLogStream = stream;

  const fmt = (level: string, args: unknown[]) =>
    `[${new Date().toISOString()}] [${level}] ` +
    args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ") +
    "\n";

  function write(line: string): void {
    // Checked before every write rather than on a timer — simplest correct
    // option for a single-process app; the extra stat() is negligible next
    // to the console/JSON-stringify work already happening on this path.
    if (rotateIfNeeded(LOG_FILE, MAX_LOG_BYTES)) {
      stream.end();
      stream = openStream();
      g.__kgLogStream = stream;
    }
    stream.write(line);
  }

  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => { write(fmt("INFO", a)); orig.log(...a); };
  console.warn = (...a: unknown[]) => { write(fmt("WARN", a)); orig.warn(...a); };
  console.error = (...a: unknown[]) => { write(fmt("ERROR", a)); orig.error(...a); };

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
