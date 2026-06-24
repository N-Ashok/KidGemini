// Auth.js route handler — mounts sign-in / callback / sign-out at /api/auth/*.
// The key lives server-side here (CLAUDE.md § 3): the client only ever calls these endpoints.

import { handlers } from "@/auth";

export const { GET, POST } = handlers;
