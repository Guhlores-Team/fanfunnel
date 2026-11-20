// Preloaded into every unit-test process by scripts/run-tests.mjs.
//
// `src/lib/supabase/server.ts` starts with `import "server-only"` so that a
// client-bundle import fails `next build` (AGENTS.md rule 3). Outside a React
// Server environment that package throws on import, which would stop unit
// tests from exercising the data layer (`src/lib/data/index.ts`) against an
// in-memory Supabase fake. Swap it for an empty module here — only here — so
// the build-time guard stays intact while tests can still load server.ts.
// src/lib/security/serverOnly.test.ts checks that this stub exists and that
// nothing under src/ ever imports it.
import { mock } from "node:test";

mock.module("server-only", { namedExports: {}, defaultExport: {} });
