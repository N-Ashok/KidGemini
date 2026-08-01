/** Parent-session clear: deletes the ari_parent cookie so leaving the Parent
 *  area always requires the PIN again on return (owner decision 2026-08-01). */
import { describe, it, expect } from "vitest";
import { POST } from "./route";

describe("POST /api/parent/session/clear", () => {
  it("C.1 always 200 and expires the ari_parent cookie, even with no session", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("ari_parent=");
    expect(cookie.toLowerCase()).toMatch(/max-age=0|expires=/);
  });
});
