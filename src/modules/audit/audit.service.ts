// Audit service — the data-access layer for the AuditLog module.
//
// All persistence goes through the shared Prisma singleton (CLAUDE.md §4.2:
// never `new PrismaClient()`). The audit trail is append-only: this module only
// ever creates rows. There is deliberately NO update or delete — `AuditLog` is
// never mutated or removed (CLAUDE.md §4.2) — and no read/list helper, since
// surfacing the trail needs admin RBAC and is owned by a later issue (#12).
//
// Compliance: callers pass only non-PII metadata (see `AuditLogEntry`). This
// service does not inspect or persist request/response bodies.
import type { AuditAction, AuditLog } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * The non-PII metadata captured for one mutating request. Mirrors the
 * `AuditLog` model minus the server-generated `id`/`createdAt`. Deliberately
 * carries no names, diagnoses, or request bodies — only "who changed what,
 * when" (Kenya Data Protection Act, 2019 accountability).
 */
export interface AuditLogEntry {
  action: AuditAction;
  entity: string;
  entityId: string | null;
  actorId: string | null;
  method: string;
  path: string;
  statusCode: number;
  ipAddress: string | null;
}

/** Append one entry to the audit trail. */
export function createAuditLog(entry: AuditLogEntry): Promise<AuditLog> {
  return prisma.auditLog.create({ data: entry });
}
