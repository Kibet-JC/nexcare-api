// Structured JSON logger for NexCare. One shared pino instance is used across
// the app (and reused by pino-http for request logging) so every log line has a
// consistent shape and the same redaction rules.
//
// Redaction is a hard requirement: per CLAUDE.md §4.1 we must never let
// credentials or PII reach the logs. The paths below cover the common places
// secrets show up in request/response objects and in error payloads. The list
// grows as new sensitive fields enter the data model.
import { pino } from 'pino';
import { env } from '../config/env.js';

// Dotted paths pino should scrub before serialising. `[*]` matches array items.
// Header names are lower-cased by Node, so we match the lower-cased form.
const REDACT_PATHS = [
  // Auth material on incoming requests / outgoing responses.
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // Credential-bearing fields that might appear in a logged body or error.
  'password',
  '*.password',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'token',
  '*.token',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
];

export const logger = pino({
  // Level is env-driven so production can dial verbosity without a code change.
  level: env.LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  // Stable, machine-parseable field names for log aggregation.
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
