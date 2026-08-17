# Logging — how to find out where it broke

**Built 2026-08-17**, owner ask: *"i need log system proper in all the code so
when it fails, i will know where to look for."*

This is the runbook. If a child reports a broken game, start here.

---

## Where the logs are

| | |
|---|---|
| **File** | `logs/app.log` in the app's working directory (override with `LOG_FILE`) |
| **On the box** | `~/kidgemini/logs/app.log`, and `pm2 logs kidgemini` for the live tail |
| **Rotation** | 10 MB ceiling, then rotated (`log-rotate.ts`). The box has 1 GB RAM — this cap is not optional |
| **Transport** | `src/lib/logger.ts` patches `console.*` once per process and tees to the file with an ISO timestamp and `INFO`/`WARN`/`ERROR` |
| **Structure** | `src/lib/turn-log.ts` — the `TurnLog` class described below |

---

## The one thing to know: `trace=`

Every request gets a **trace id** — 8 characters, e.g. `k3f9a2xr`. Every log
line that request produces carries it.

```bash
grep 'trace=k3f9a2xr' logs/app.log
```

That is the complete, ordered story of one turn: the gates it passed, the model
call, each patch attempt, the lint, and what was delivered.

**It spans the self-heal too.** The trace is returned to the browser in the
chat `done` payload, stored on the message, and sent back with any
`/api/repair` call that game later makes. So a build, its edits and its repairs
all sit on one thread — which is exactly what was impossible before: the
2026-08-17 investigation had to match a chat turn to its repair by comparing
character counts across timestamps by eye.

Getting the id from a child's report: it is not shown in the UI (deliberately).
Find the turn by time and user instead:

```bash
grep 'stage=start' logs/app.log | grep 'userId=<id>' | tail -5
```

then grep the trace from the line that matches.

---

## The line format

```
[2026-08-17T09:31:04.221Z] [INFO] [api/chat] trace=k3f9a2xr stage=patch outcome=ok ms=1841 rung=direct
[2026-08-17T09:31:59.087Z] [WARN] [api/chat] trace=k3f9a2xr stage=lint outcome=warn ms=71804 fault=unknown_three_imports bad=loadModel,placeModel
```

| field | meaning |
|---|---|
| `[api/chat]` | the surface — matches the pre-existing prefix convention |
| `trace=` | the correlation key |
| `stage=` | where in the pipeline this is (see the vocabulary below) |
| `outcome=` | `ok` \| `warn` \| `skip` \| `fail` |
| `ms=` | milliseconds since this request started |
| everything else | facts, always `key=value` |

`outcome` also picks the console level, so `ERROR` in the file means a real
failure and nothing else does.

**`skip` vs `warn` is deliberate.** `skip` = we chose not to (a rung not taken,
a gate that declined). `warn` = something went wrong but we continued. They are
separately greppable because "the rung declined" and "the rung broke" need
different responses.

---

## Stage vocabulary

The point of naming stages is that **a missing stage is itself the finding** —
a turn that logs `start` and then nothing died between two of them, and you can
see that without having the pipeline memorised.

### `api/chat`

| stage | meaning |
|---|---|
| `start` | request accepted, gates passed |
| `stream` | the model's answer finished (`chars=`) |
| `inject` | asset injection (import map, `AR_ASSETS`, runtime helpers) |
| `patch` | an edit was applied — `rung=direct` \| `strict_retry` \| `cheap_strict` |
| `lint` | a pre-delivery fault was found (`fault=`, `bad=`) |
| `lint_retry` | the corrective regeneration for that fault |
| `deliver` | the game was sent to the child (`model=`, `fallback=`) |
| `session` | SSO lookup failed; treated as guest |

### `api/repair` (the self-heal)

| stage | meaning |
|---|---|
| `request` | a verify failure arrived (`code=`, `htmlChars=`, `err=`) |
| `model` | the repair model call |
| `strict_retry` | the rescue rung — `rescued=true` means it produced the patch |
| `apply_patch` | the patch could not be applied (`reason=`) |
| `deliver` | the repaired game went back to the browser |
| `usage` | usage bookkeeping failed (ignored — never fails a repair) |

---

## Recipes

```bash
# The whole story of one turn, including its repairs
grep 'trace=k3f9a2xr' logs/app.log

# What is failing most this week, ranked
grep -o 'stage=[a-z_]* outcome=fail' logs/app.log | sort | uniq -c | sort -rn

# Which generation faults the lint is catching
grep 'stage=lint' logs/app.log | grep -o 'bad=[^ ]*' | sort | uniq -c | sort -rn

# How often each edit rung rescues a turn (direct vs strict_retry vs cheap_strict)
grep 'stage=patch outcome=ok' logs/app.log | grep -o 'rung=[a-z_]*' | sort | uniq -c

# Edits that were lost entirely (soft-fail — the child's ask did nothing)
grep 'stage=patch outcome=fail' logs/app.log

# Self-heal effectiveness: how many repairs needed the rescue rung
grep 'stage=strict_retry' logs/app.log | grep -c 'rescued=true'

# Turns that started and never delivered — died somewhere in between
comm -23 <(grep -o 'trace=[a-z0-9]*' logs/app.log | sort -u) \
         <(grep 'stage=deliver' logs/app.log | grep -o 'trace=[a-z0-9]*' | sort -u)
```

That last one is the whole argument for stage names: it finds turns that broke
in a way nobody wrote a log line for.

---

## Rules for adding logs

1. **Never log free text from a child or a model.** These are children's
   sessions. Log `chars=`, not the message. Log `code=start_occluded`, not the
   console output. The one exception is JS error text from generated code — our
   own model's output about our own runtime — and it goes through
   `formatRepairErrorSummary`, which truncates it.
2. **Never interpolate a value into prose.** `stage=lint bad=loadModel` is
   countable; "unknown three imports: loadModel" is not.
3. **Never pass an object as a field value.** The type forbids it. This is the
   `err="[object Object]"` bug (BUG-FIX-LOG 2026-08-17) made unrepresentable —
   an instrument built to make faults countable that could not name one.
   Use `log.fail(stage, err)`, which unwraps any shape correctly.
4. **Use the existing stage names** where one fits. A new name for an existing
   stage silently splits every count that stage appears in.
5. **A logging bug must never break a child's game.** `TurnLog` never throws;
   keep it that way.

---

## Known gaps

- **Published games have no error capture at all.** `injectConsoleCapture` is
  wired only into the preview (`ArtifactFrame`) and `preview-verify`. Once a
  game is published and a real child plays it, nothing is logged — no console,
  no errors, no self-heal. Closing this means collecting data from children's
  sessions, so it is a **privacy decision for the owner first**, not an
  engineering task. Tracked as C2 in
  `docs/2026-08-17_PRD_GenerationPipelineRemediation.md`.
- **No aggregation.** These recipes are `grep` over one file on one box. That
  is the right size for today and will not survive a second app server.
- **~45 chat lines are still prose** carrying a trace but no `stage=`. They are
  correlated and readable; they are not yet countable. Converting them is
  mechanical and safe to do incrementally — the highest-value decision points
  were converted first.
