// Which Google transport serves a Gemini call: AI Studio (default) or Vertex AI
// express mode. One choke point, so gemini.ts and safety.ts can never drift onto
// different backends — a split would send the generation call to Vertex and the
// safety classifier to Studio, quietly breaking the "same posture everywhere"
// assumption the child-safety layers rest on.
//
// Vertex EXPRESS mode is what this supports: `vertexai: true` plus an API key,
// no service account, no ADC, no project/location. That is the shape the owner
// supplied (2026-08-12) and it keeps the switch to transport only.
//
// What this deliberately does NOT change: model ids, safetySettings, thinking
// budgets, the fallback chain. Flipping GEMINI_BACKEND must be reversible by
// flipping it back — see docs/2026-08-12_PRD_VertexBackendAndDeepSeek.md.

export type GoogleBackend = "studio" | "vertex";

/** Options accepted by `new GoogleGenAI(...)`, narrowed to the two shapes we use. */
export type GoogleClientOptions =
  | { apiKey: string }
  | { vertexai: true; apiKey: string };

export class GoogleBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleBackendError";
  }
}

/**
 * Reads GEMINI_BACKEND. Unset → "studio", which is the path every live turn
 * takes today; the gate is off until someone types the value.
 *
 * An unrecognised value THROWS rather than defaulting. A typo that silently
 * kept serving Studio would let an operator believe they had cut over to Vertex
 * — the failure mode this switch exists to make visible.
 */
export function resolveBackend(env: Record<string, string | undefined>): GoogleBackend {
  const raw = (env.GEMINI_BACKEND ?? "").trim().toLowerCase();
  if (!raw) return "studio";
  if (raw === "studio" || raw === "vertex") return raw;
  throw new GoogleBackendError(
    `GEMINI_BACKEND="${env.GEMINI_BACKEND}" is not a backend. Set GEMINI_BACKEND=studio (AI Studio, the default) or GEMINI_BACKEND=vertex (Vertex AI express).`,
  );
}

/**
 * The constructor options for the selected backend.
 *
 * Vertex uses its OWN key (VERTEX_API_KEY) and never borrows GEMINI_API_KEY: an
 * AI Studio key is a different credential against a different billing account,
 * so a silent fallback would 401 mid-turn instead of failing at boot with an
 * actionable message.
 */
export function googleClientOptions(env: Record<string, string | undefined>): GoogleClientOptions {
  const backend = resolveBackend(env);

  if (backend === "vertex") {
    const apiKey = env.VERTEX_API_KEY;
    if (!apiKey) {
      throw new GoogleBackendError(
        "VERTEX_API_KEY is not set, and GEMINI_BACKEND=vertex. Set VERTEX_API_KEY to a Vertex AI express key, or set GEMINI_BACKEND=studio to go back to AI Studio.",
      );
    }
    return { vertexai: true, apiKey };
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new GoogleBackendError("GEMINI_API_KEY is not set");
  return { apiKey };
}
