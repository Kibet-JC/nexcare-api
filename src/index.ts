// Process entrypoint: build the app, bind the HTTP server, and wire graceful
// shutdown. Kept separate from src/app.ts so the app factory has no side
// effects and stays trivially testable.
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';

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
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
    // HTTP is drained; now release the database pool before exiting so Postgres
    // doesn't hold the connections open until they time out.
    prisma
      .$disconnect()
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      })
      .catch((disconnectErr: unknown) => {
        logger.error({ err: disconnectErr }, 'error disconnecting prisma');
        process.exit(1);
      });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
