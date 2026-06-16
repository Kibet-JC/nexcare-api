// Process entrypoint: build the app, bind the HTTP server, and wire graceful
// shutdown. Kept separate from src/app.ts so the app factory has no side
// effects and stays trivially testable.
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { logger } from './lib/logger.js';

// TODO(#4): replace this ad-hoc PORT read with the Zod-validated, fail-fast env
// schema. For now a parsed PORT with a 3000 fallback is enough to boot.
const PORT = Number(process.env.PORT ?? 3000);

const app = createApp();

const server: Server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'nexcare-api listening');
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
    logger.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
