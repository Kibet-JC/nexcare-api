// Global audit middleware — records every mutating request for Kenya Data
// Protection Act, 2019 accountability (CLAUDE.md §4.1: every mutating request
// writes an AuditLog entry). Registered once in src/app.ts before the routers;
// individual routes are untouched except for an optional `res.locals` hook that
// exposes the id of a freshly-created row.
//
// Design notes:
//  - Reads (GET/HEAD/OPTIONS) are never audited — only POST/PUT/PATCH/DELETE.
//  - The entry is written on the response `finish` event so the real status
//    code is known and the audit write never sits on the request's critical
//    path. A failed audit write is logged via pino and NEVER breaks the
//    response the client already received.
//  - Compliance: only non-PII metadata is captured (action, entity, entity id,
//    actor id, method, pathname, status, ip, time). No bodies, names, or
//    diagnoses ever touch this table.
import type { RequestHandler } from 'express';
import { AuditAction } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { createAuditLog } from '../modules/audit/audit.service.js';

// HTTP method -> audit action. Only these four methods are audited; any other
// method (GET/HEAD/OPTIONS) is absent here and therefore skipped. PUT and PATCH
// are both updates.
const ACTION_BY_METHOD: Record<string, AuditAction> = {
  POST: AuditAction.CREATE,
  PUT: AuditAction.UPDATE,
  PATCH: AuditAction.UPDATE,
  DELETE: AuditAction.DELETE,
};

/**
 * Naive singularisation good enough for our REST collections: strip a single
 * trailing "s" ("patients" -> "patient", "appointments" -> "appointment").
 * Resources here are simple plurals, so this needs no irregular-noun handling.
 */
function singularize(segment: string): string {
  return segment.endsWith('s') ? segment.slice(0, -1) : segment;
}

/**
 * Resolve the resource type and (when present) the target row id from the
 * request pathname, e.g. "/api/v1/patients/abc123" -> { entity: "patient",
 * id: "abc123" }. The segment after "v1" is the collection; the one after that,
 * if any, is the row id. Parsing the path ourselves keeps this independent of
 * Express route params, which are not reliably populated in a `finish` handler
 * that runs above the routers.
 */
function describeTarget(path: string): { entity: string; id: string | null } {
  const segments = path.split('/').filter(Boolean);
  const versionIndex = segments.indexOf('v1');
  const start = versionIndex >= 0 ? versionIndex + 1 : 0;
  const collection = segments[start];
  const id = segments[start + 1] ?? null;

  return {
    entity: collection ? singularize(collection) : 'unknown',
    id,
  };
}

/**
 * Express middleware that appends one AuditLog row per mutating request.
 * Non-mutating methods pass straight through.
 */
export const audit: RequestHandler = (req, res, next) => {
  const action = ACTION_BY_METHOD[req.method];
  if (!action) {
    // Non-mutating method (GET/HEAD/OPTIONS): never audited.
    return next();
  }

  // Capture request fields NOW, before the routers run. Express mutates
  // req.url/req.path as it descends into mounted routers (it becomes "/" inside
  // the matched route), so reading them inside the `finish` handler would
  // record the wrong path. Method and ip are stable but captured here too.
  const method = req.method;
  const path = req.path;
  const ipAddress = req.ip ?? null;
  const { entity, id: pathId } = describeTarget(path);

  res.on('finish', () => {
    // Create routes expose the new row's id via res.locals.auditEntityId; for
    // updates/deletes we fall back to the :id parsed from the path.
    const localId = res.locals.auditEntityId;
    const entityId =
      typeof localId === 'string' && localId.length > 0 ? localId : pathId;

    void createAuditLog({
      action,
      entity,
      entityId,
      // The acting user, resolved by the authenticate middleware (#12) which
      // runs on every protected route before the handler. By the time this
      // `finish` handler fires, `req.user` is populated for any authenticated
      // mutation; it stays null only for an unauthenticated request (e.g. one
      // rejected with 401 before reaching a handler).
      actorId: req.user?.id ?? null,
      method,
      // Pathname only — never req.originalUrl, so query strings (which could
      // carry PII) are kept out of the audit table.
      path,
      statusCode: res.statusCode,
      ipAddress,
    }).catch((err: unknown) => {
      // An audit failure must never break a response the client already has.
      logger.error(
        { err, entity, action, method: req.method },
        'failed to write audit log',
      );
    });
  });

  next();
};
