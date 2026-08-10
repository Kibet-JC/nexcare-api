// Error tracking (Sentry) — Issue H-7.
//
// NexCare reports server-side faults to Sentry so a 500 in production is
// visible without shell access to the container. Three properties matter more
// than the reporting itself, and they shape every decision in this file:
//
//   1. OFF MEANS ABSENT. When SENTRY_DSN is unset — development, test, CI —
//      `@sentry/node` is never even imported. The SDK is pulled in by a dynamic
//      import inside initSentry(), so with no DSN there is no client, no
//      transport, and no code path that could reach the network. "Disabled" is
//      not a flag the SDK checks; the SDK simply is not loaded.
//   2. NO AUTO-INSTRUMENTATION. `defaultIntegrations: false` with an empty
//      integrations list means nothing hooks http, console, or the process.
//      Capture happens in exactly one place: the Express error handler
//      (lib/problem.ts). This removes the machinery that would otherwise
//      auto-attach request bodies, headers and cookies to an event, so
//      scrubbing is defence in depth rather than the only line of defence.
//      Known limitation (deliberate, see the PR for #H-7): an uncaught
//      exception thrown outside the Express error handler is therefore NOT
//      reported.
//   3. NO PERSONAL DATA ON THE WIRE. Sentry is a third-party processor outside
//      Kenya. beforeSend (scrubEvent below) drops the containers that carry
//      personal data outright, then rewrites every remaining string to mask
//      anything shaped like a national ID, phone number or email address.
//      What survives is what an operator actually needs: route, method,
//      status, request ID, error type and stack.
//
// Never call captureException directly from application code — go through
// captureProblem() so the tagging and the disabled-path guard stay in one place.
import type { ErrorEvent, NodeOptions } from '@sentry/node';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/** The lazily-imported SDK. Non-null exactly when Sentry is enabled. */
type SentryModule = typeof import('@sentry/node');
let sdk: SentryModule | null = null;

/** What we are willing to send about the request that failed. */
export interface ProblemContext {
  method: string;
  route: string;
  status: number;
  requestId?: string;
}

const REDACTED = '[REDACTED]';

// Keys whose VALUES are dropped wholesale wherever they appear in an event,
// at any depth. These are the containers that carry credentials or patient
// data verbatim, so masking their contents is pointless — the whole value goes.
// `data` and `body` are Sentry's names for a captured request body.
const DROPPED_KEYS = new Set([
  'data',
  'body',
  'cookies',
  'cookie',
  'headers',
  'authorization',
  'query_string',
  'env',
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'passwordHash',
  'nationalId',
  'phone',
  'phoneNumber',
  'email',
]);

// Value-shaped personal data, masked wherever a string survives the key sweep
// above (error messages are the usual carrier: "no patient with phone +254…").
// Ordered longest-shape-first so a phone number inside an email is not
// half-masked before the email pattern sees it.
const PII_PATTERNS: readonly RegExp[] = [
  // Email address.
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // Kenyan mobile in E.164 (the storage format — CLAUDE.md §4.2).
  /\+254\s?\d{9}\b/g,
  // Kenyan mobile in local form, e.g. 0712345678 / 0112345678.
  /\b0[17]\d{8}\b/g,
  // Any other international number a caller might have typed.
  /\+\d{9,15}\b/g,
  // Kenyan national ID: a bare 7-8 digit number. The word boundaries keep this
  // off longer digit runs (timestamps, the digit segments inside a UUID).
  /\b\d{7,8}\b/g,
];

// Depth cap on the recursive walk: a Sentry event is a bounded JSON tree, and a
// cap means a pathological or cyclic structure can never hang the send path.
// A plain error event already reaches depth 7 at the stack-frame fields
// (exception.values[].stacktrace.frames[].filename), so the cap sits above that
// with room to spare — anything past it is dropped, never passed through
// unscrubbed.
const MAX_DEPTH = 12;

/** Mask every personal-data shape in a single string. */
function redactString(value: string): string {
  return PII_PATTERNS.reduce(
    (masked, pattern) => masked.replace(pattern, REDACTED),
    value,
  );
}

/** Drop the query string from a URL, keeping the path. Query strings carry
 *  search terms ("?q=Jane Doe"); the path carries only identifiers, which
 *  CLAUDE.md §4.1 explicitly permits. Works on absolute and relative URLs. */
function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Recursively rebuild a value with sensitive keys removed and every remaining
 * string masked. Returns new objects rather than mutating, so the caller's
 * input is never half-scrubbed if this throws.
 */
function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return undefined;

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED_KEYS.has(key)) continue;
    out[key] = redactDeep(nested, depth + 1);
  }
  return out;
}

/**
 * The `beforeSend` hook, exported so the redaction can be tested directly
 * without a DSN, a client, or a network.
 *
 * Two passes. First the whole-container drops: `user` (id, email, IP),
 * `server_name` (host identity) and `breadcrumbs` (a trail of prior activity we
 * neither need nor control the contents of). `request` is rebuilt from scratch
 * as method + path, which is the only safe way to be sure nothing else on it
 * survives. Then the recursive key/value sweep over what is left.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const { user: _user, server_name: _serverName, breadcrumbs: _crumbs, ...rest } = event;

  const narrowed: ErrorEvent = { ...rest };
  if (event.request) {
    narrowed.request = {
      ...(event.request.method ? { method: event.request.method } : {}),
      ...(event.request.url ? { url: stripQuery(event.request.url) } : {}),
    };
  }

  return redactDeep(narrowed) as ErrorEvent;
}

/** True when the SDK is loaded and initialised, i.e. events can be sent. */
export function isSentryEnabled(): boolean {
  return sdk !== null;
}

/**
 * Load and initialise Sentry if — and only if — a DSN is configured outside the
 * test environment. Idempotent. Returns whether Sentry ended up enabled.
 *
 * The NODE_ENV === 'test' short-circuit is not redundant with the DSN check: a
 * developer with SENTRY_DSN in their local .env must not ship errors to the
 * production project every time they run `pnpm test`.
 */
export async function initSentry(): Promise<boolean> {
  if (sdk) return true;

  if (env.NODE_ENV === 'test') {
    return false;
  }
  if (!env.SENTRY_DSN) {
    logger.info('sentry error tracking disabled (SENTRY_DSN not set)');
    return false;
  }

  // Release is best-effort and must stay cheap: RAILWAY_GIT_COMMIT_SHA is
  // injected by the platform at runtime, so no `git` binary and no .git
  // directory are needed inside the container (neither exists there).
  const release = env.SENTRY_RELEASE ?? env.RAILWAY_GIT_COMMIT_SHA;

  const options: NodeOptions = {
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    ...(release ? { release } : {}),
    // See note 2 in the file header: no auto-instrumentation of any kind.
    defaultIntegrations: false,
    integrations: [],
    // Belt and braces on top of the integration list: never let the SDK decide
    // that request data, IPs or user identity are safe to attach.
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    // Errors only. Performance tracing would sample real request traffic, which
    // is a much larger data-egress surface than this issue signed up for.
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
  };

  // Error tracking must never be the reason a clinical API fails to boot. This
  // runs at top-level await in src/index.ts, so an unhandled throw here would
  // take the process down before it ever listens — trading patient-facing
  // availability for observability, which is the wrong way round. A failure is
  // logged at error level (loud enough to notice a broken DSN) and the app
  // continues with Sentry off.
  try {
    const mod = await import('@sentry/node');
    mod.init(options);
    sdk = mod;
  } catch (initError) {
    logger.error(
      { err: initError },
      'sentry initialisation failed; continuing with error tracking disabled',
    );
    return false;
  }

  logger.info(
    { environment: env.NODE_ENV, release: release ?? null },
    'sentry error tracking enabled',
  );
  return true;
}

/**
 * Report a failed request. A no-op when Sentry is disabled, which is what keeps
 * the call site in lib/problem.ts free of environment branching.
 *
 * Only the four context fields are attached, as tags: they are the fields an
 * operator triages on, and none of them is personal data. Everything else about
 * the request is left off the event deliberately.
 */
export function captureProblem(error: unknown, context: ProblemContext): void {
  if (!sdk) return;

  const client = sdk;
  try {
    client.withScope((scope) => {
      scope.setTag('http.method', context.method);
      scope.setTag('http.route', context.route);
      scope.setTag('http.status_code', String(context.status));
      if (context.requestId) scope.setTag('request_id', context.requestId);
      scope.setTransactionName(`${context.method} ${context.route}`);
      client.captureException(error);
    });
  } catch (captureError) {
    // Error tracking must never be able to break the response it is reporting
    // on. The error handler has already written the Problem Details body by the
    // time this runs, but a throw here would still surface as an unhandled
    // rejection in the process.
    logger.warn({ err: captureError }, 'failed to report error to sentry');
  }
}

/**
 * Flush queued events before the process exits. Without this, the last error
 * before a SIGTERM is lost on every ordinary deploy — the same class of gap the
 * audit-write barrier closes in middleware/audit.ts. Bounded by `timeoutMs` so
 * an unreachable Sentry delays shutdown by seconds, never indefinitely.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.flush(timeoutMs);
  } catch (flushError) {
    logger.warn({ err: flushError }, 'sentry flush failed during shutdown');
  }
}
