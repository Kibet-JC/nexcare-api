// Side-effecting module: repoint DATABASE_URL at the isolated test database.
//
// This MUST be imported before anything that pulls in src/config/env.ts or the
// Prisma singleton. ES module imports are hoisted and evaluated in source order,
// so a plain assignment statement placed "above" an import would still run too
// late. Isolating the assignment in its own module and importing it first
// guarantees it executes before the env/prisma imports that follow it.
//
// env.ts is written NOT to override an already-set process.env value, so once we
// set DATABASE_URL here, env.ts (and therefore the Prisma client) locks onto the
// test database — never nexcare_dev.
import { testDatabaseUrl } from './test-db-url.js';

process.env.DATABASE_URL = testDatabaseUrl();
