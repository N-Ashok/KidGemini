/**
 * The models bridge. Auth is the whole test surface — the payload itself is
 * covered by model-catalogue.test.ts. Mirrors usage-bridge's contract exactly,
 * including the fail-closed 503, because a bridge that silently opens when its
 * secret is unset is the worst possible failure mode for an admin route.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const SECRET = "test-shared-secret-value";
const req = (headers: Record<string, string> = {}) =>
  new NextRequest("https://ari.example.com/api/admin/models-bridge", { method: "POST", headers });

let saved: string | undefined;
beforeEach(() => { saved = process.env.AUTH_JWT_SECRET; process.env.AUTH_JWT_SECRET = SECRET; });
afterEach(() => { if (saved === undefined) delete process.env.AUTH_JWT_SECRET; else process.env.AUTH_JWT_SECRET = saved; });

describe("models-bridge auth", () => {
  it("MB.1 serves the catalogue with the shared secret", async () => {
    const res = await POST(req({ "x-admin-secret": SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models.length).toBeGreaterThan(300);
    expect(body.summary.total).toBe(body.models.length);
    // THREE buckets since 2026-08-23, not two: a model with no animation clips
    // may still have a part a game turns (25 vehicles' wheels, the helicopter's
    // rotor). Folding those into "static" is what made the rebuilt helicopter
    // read as inert on the admin tab.
    expect(body.summary.animated + body.summary.spinnable + body.summary.static).toBe(body.summary.total);
    expect(body.summary.spinnable).toBeGreaterThan(20);
  });

  it("MB.2 refuses a wrong secret", async () => {
    expect((await POST(req({ "x-admin-secret": "nope" }))).status).toBe(403);
  });

  it("MB.3 refuses a missing secret", async () => {
    expect((await POST(req())).status).toBe(403);
  });

  it("MB.4 FAILS CLOSED when the server has no secret configured", async () => {
    delete process.env.AUTH_JWT_SECRET;
    const res = await POST(req({ "x-admin-secret": SECRET }));
    expect(res.status).toBe(503);
  });

  it("MB.5 a model's abilities ride along, so the tab has something to show", async () => {
    const body = await (await POST(req({ "x-admin-secret": SECRET }))).json();
    const dog = body.models.find((m: { name: string }) => m.name === "dog");
    expect(dog.abilities).toEqual(expect.arrayContaining(["walk", "run"]));
    expect(dog.usage.animate).toContain("AnimationMixer");
  });
});
