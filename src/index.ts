// Process entrypoint: build the app, bind the HTTP server, and wire graceful
// shutdown. Kept separate from src/app.ts so the app factory has no side
// effects and stays trivially testable.
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { flushSentry, initSentry } from './lib/sentry.js';
import { auditWritesSettled } from './middleware/audit.js';

// Error tracking first, so a fault raised while the app is being built is
// already reportable. Resolves to a no-op without SENTRY_DSN (H-7).
await initSentry();

const app = createApp();

const server: Server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'nexcare-api listening');
});

/**
 * Stop accepting new connections, drain in-flight requests, then exit. Bound to
 * SIGTERM (orchestrator stop) and SIGINT (Ctrl-C in dev).
 */
function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutdown signal received, draining connections');
  server.close((err) => {
    if (err) {
      // Log, but still fall through to the drain below rather than exiting
      // here: a failed server.close() does not mean audit writes are absent,
      // and exiting immediately would discard exactly the rows this barrier
      // exists to save. The non-zero exit code is preserved via `closeFailed`.
      logger.error({ err }, 'error during shutdown');
    }
    const closeFailed = Boolean(err);

    // HTTP is drained — but the audit middleware issues its insert on the
    // response `finish` event, by which point the request is already complete
    // and server.close() no longer waits for it. Those writes must settle
    // BEFORE the pool closes, or an audit row issued in the last milliseconds
    // before SIGTERM is lost on every ordinary deploy: a patient record
    // mutating with no trail, which is an accountability gap rather than a
    // dropped log line. The barrier is bounded (see middleware/audit.ts), so a
    // sick database delays shutdown by seconds, never indefinitely.
    // Same reasoning as the audit barrier applies to Sentry's send queue: an
    // error captured in the last milliseconds before SIGTERM is still in memory
    // and would be lost on every ordinary deploy. Both barriers are bounded.
    auditWritesSettled()
      .then(() => flushSentry())
      .then(() => prisma.$disconnect())
      .then(() => {
        logger.info('shutdown complete');
        process.exit(closeFailed ? 1 : 0);
      })
      .catch((shutdownErr: unknown) => {
        logger.error({ err: shutdownErr }, 'error draining or disconnecting prisma');
        process.exit(1);
      });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
