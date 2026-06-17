// Patient service — the data-access layer for the Patient module.
//
// All persistence goes through the shared Prisma singleton (CLAUDE.md §4.2:
// never `new PrismaClient()`). The HTTP layer (routes) stays thin; business
// rules — soft-delete semantics, "not found" handling — live here so later
// callers (other services, jobs) get the same guarantees as the API.
//
// Soft delete: `deletedAt` marks a row as deleted without removing it, so
// clinical history is retained (CLAUDE.md §4.2). Every read filters out
// soft-deleted rows, so a deleted patient is invisible to the API but the row
// persists in the database.
import type { Patient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { HttpProblem } from '../../lib/problem.js';
import type {
  CreatePatientInput,
  ListQuery,
  UpdatePatientInput,
} from './patient.schema.js';

/** Only active (non-soft-deleted) patients are visible to the API. */
const ACTIVE = { deletedAt: null } as const;

/** Create a patient. */
export function createPatient(input: CreatePatientInput): Promise<Patient> {
  return prisma.patient.create({ data: input });
}

/** Return one page of active patients, newest first. */
export function listPatients({ limit, offset }: ListQuery): Promise<Patient[]> {
  return prisma.patient.findMany({
    where: ACTIVE,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

/**
 * Fetch a single active patient or throw 404. Centralising the "not found"
 * decision here keeps every caller (get/update/delete) consistent: a
 * soft-deleted or unknown id is indistinguishable to the client.
 */
export async function getPatient(id: string): Promise<Patient> {
  const patient = await prisma.patient.findFirst({ where: { id, ...ACTIVE } });

  if (!patient) {
    throw new HttpProblem(404, 'Not Found', `No patient with id ${id}`);
  }

  return patient;
}

/** Update an active patient, or throw 404 if it is missing/soft-deleted. */
export async function updatePatient(
  id: string,
  input: UpdatePatientInput,
): Promise<Patient> {
  // Guard first so updating a soft-deleted/unknown id 404s rather than resurrecting
  // or 500-ing on a missing row.
  await getPatient(id);

  return prisma.patient.update({ where: { id }, data: input });
}

/**
 * Soft delete: stamp `deletedAt` instead of removing the row. Returns nothing;
 * throws 404 if the patient is already gone.
 */
export async function deletePatient(id: string): Promise<void> {
  await getPatient(id);

  await prisma.patient.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}
