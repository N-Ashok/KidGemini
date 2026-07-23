/** /api/session exposes the verified-adult claim so the client can match the
 *  server's fail-closed Bible-games tag (PRD-BIBLE-TEACHER §5). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getSession = vi.fn();
vi.mock("@/lib/ariantra-session.server", () => ({
  getAriantraSession: () => getSession(),
}));

import { GET } from "./route";

beforeEach(() => getSession.mockReset());

describe("/api/session — adult claim", () => {
  it("SS.1 an adult session reports adult:true", async () => {
    getSession.mockResolvedValue({ name: "Ms Ruth", email: "ruth@x.co", adult: true });
    const body = await (await GET()).json();
    expect(body.user).toMatchObject({ name: "Ms Ruth", adult: true });
  });

  it("SS.2 a non-adult session reports adult:false (fail closed — absent claim is not adult)", async () => {
    getSession.mockResolvedValue({ name: "Agilan", email: null });
    const body = await (await GET()).json();
    expect(body.user.adult).toBe(false);
  });

  it("SS.3 signed out → user null", async () => {
    getSession.mockResolvedValue(null);
    const body = await (await GET()).json();
    expect(body.user).toBeNull();
  });
});
