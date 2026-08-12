// The Google transport switch: AI Studio (default) vs Vertex AI express mode.
//
// The whole point of these tests is that flipping the backend is a TRANSPORT
// change and nothing else — same SDK, same models, same safetySettings. What
// must never happen is a silent flip: an unset/typo'd value that quietly serves
// a different backend, or a vertex run that falls back to the Studio key and
// authenticates against the wrong billing account.
import { describe, expect, it } from "vitest";
import { GoogleBackendError, googleClientOptions, resolveBackend } from "./google-backend";

describe("resolveBackend", () => {
  it("GB.1 defaults to studio when GEMINI_BACKEND is unset — the live path is unchanged", () => {
    expect(resolveBackend({})).toBe("studio");
    expect(resolveBackend({ GEMINI_BACKEND: "" })).toBe("studio");
  });

  it("GB.2 accepts vertex, case- and whitespace-insensitively", () => {
    expect(resolveBackend({ GEMINI_BACKEND: "vertex" })).toBe("vertex");
    expect(resolveBackend({ GEMINI_BACKEND: " VERTEX " })).toBe("vertex");
  });

  it("GB.3 fails CLOSED on an unrecognised value rather than defaulting", () => {
    // A typo'd GEMINI_BACKEND=vertexai must not silently serve Studio traffic
    // while the operator believes they cut over.
    expect(() => resolveBackend({ GEMINI_BACKEND: "vertexai" })).toThrow(GoogleBackendError);
    expect(() => resolveBackend({ GEMINI_BACKEND: "vertexai" })).toThrow(/studio.*vertex/i);
  });
});

describe("googleClientOptions", () => {
  it("GB.4 studio → a plain API key, and NO vertexai flag", () => {
    const opts = googleClientOptions({ GEMINI_API_KEY: "studio-key" });
    expect(opts).toEqual({ apiKey: "studio-key" });
    expect("vertexai" in opts).toBe(false);
  });

  it("GB.5 vertex → express mode: vertexai true + the Vertex key", () => {
    const opts = googleClientOptions({
      GEMINI_BACKEND: "vertex",
      GEMINI_API_KEY: "studio-key",
      VERTEX_API_KEY: "vertex-key",
    });
    expect(opts).toEqual({ vertexai: true, apiKey: "vertex-key" });
  });

  it("GB.6 vertex NEVER borrows GEMINI_API_KEY — a Studio key is a different credential", () => {
    // Falling back would authenticate against the wrong project and bill the
    // wrong account, and the failure would surface as a confusing 401 deep in a
    // kid's turn rather than at boot.
    expect(() => googleClientOptions({ GEMINI_BACKEND: "vertex", GEMINI_API_KEY: "studio-key" })).toThrow(
      /VERTEX_API_KEY/,
    );
  });

  it("GB.7 studio with no key keeps the existing message", () => {
    expect(() => googleClientOptions({})).toThrow("GEMINI_API_KEY is not set");
  });

  it("GB.8 the error says what to set — both the var and the backend it belongs to", () => {
    expect(() => googleClientOptions({ GEMINI_BACKEND: "vertex" })).toThrow(/GEMINI_BACKEND=vertex/);
  });
});
