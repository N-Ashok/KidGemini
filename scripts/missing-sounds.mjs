// The weekly sound shopping list (owner decision 2026-08-29).
//
// When a generated game calls for an asset we do not own, we play NOTHING —
// a wrong sound is worse than none — and record the miss in `missing_assets`.
// This prints that register, most-wanted first, so the weekly review can turn
// real demand into new library assets. Read-only; nothing kid-facing.
//
//   node scripts/missing-sounds.mjs            # top 50
//   node scripts/missing-sounds.mjs 20         # top 20
//   DATABASE_PATH=~/kidgemini/data/kidgemini.db node scripts/missing-sounds.mjs
import Database from "better-sqlite3";

const limit = Number(process.argv[2]) || 50;
const path = process.env.DATABASE_PATH || "data/kidgemini.db";
const db = new Database(path, { readonly: true });

let rows = [];
try {
  rows = db
    .prepare("SELECT name, kind, count, firstSeen, lastSeen FROM missing_assets ORDER BY count DESC, lastSeen DESC LIMIT ?")
    .all(limit);
} catch (e) {
  console.error(`could not read missing_assets (${e.message}) — has a game shipped since this landed?`);
  process.exit(1);
}

if (!rows.length) {
  console.log("No missing sounds recorded. Either the library covers what games ask for, or nothing has shipped since this landed.");
  process.exit(0);
}

const d = (ms) => new Date(ms).toISOString().slice(0, 10);
console.log(`Sounds games asked for and we do NOT have (${rows.length}), most-wanted first:\n`);
console.log("  count  kind   name                      first seen   last seen");
for (const r of rows) {
  console.log(`  ${String(r.count).padStart(5)}  ${r.kind.padEnd(5)}  ${r.name.padEnd(24)}  ${d(r.firstSeen)}   ${d(r.lastSeen)}`);
}
console.log(`\nAdd the top ones to the asset library, then re-run scripts/build-manifest (or the usual asset flow).`);
console.log(`Every game that already asked for a name starts working the day that asset lands — the call was left in on purpose.`);
