// Per-request model-decision ledger writer (owner ask 2026-07-21).
//
// Appends ONE JSON line per request to logs/model-decisions.jsonl: which models
// were called for that one request, why (role), when (elapsed), how each ended,
// and which won. Separate from app.log ON PURPOSE — app.log is prose tee'd from
// console and buried in HTTP noise; this file is structured JSONL you can grep
// or feed to jq to answer "how many calls did this request make and what won"
// long after the fact. See src/types/model-ledger.types.ts for the shape.
//
// Fail-safe like the rest of the bookkeeping path (trackTurn/recordUsage): a
// ledger write must NEVER throw into a request. Best-effort only.

import fs from "node:fs";
import path from "node:path";
import { rotateIfNeeded } from "./log-rotate";
import type { DecisionLedger } from "@/types/model-ledger.types";

// Same 10MB ceiling as app.log (logger.ts): the box pm2-restarts at a memory
// cap out of ~908MB total, so an unbounded decision log is exactly the disk
// pressure the app's unguarded SQLite writes are least prepared for. On
// rotation the current file moves to <path>.1 (one generation kept).
const MAX_LEDGER_BYTES = 10 * 1024 * 1024;

/** Read the path lazily so a test can point MODEL_LEDGER_FILE at a tmp file. */
export function ledgerPath(): string {
  return process.env.MODEL_LEDGER_FILE || path.join(process.cwd(), "logs", "model-decisions.jsonl");
}

/** Append one request's decision ledger. Never throws. */
export function writeDecision(entry: DecisionLedger): void {
  try {
    const file = ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file, MAX_LEDGER_BYTES);
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    // Bookkeeping only — losing a ledger line must not break a child's turn.
  }
}
