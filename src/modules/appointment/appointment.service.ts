// Appointment service — the data-access layer for the Appointment module.
//
// All persistence goes through the shared Prisma singleton (CLAUDE.md §4.2:
// never `new PrismaClient()`). The HTTP layer (routes) stays thin; business
// rules — soft-delete semantics, "not found" handling, and referential
// integrity — live here so later callers get the same guarantees as the API.
//
// Referential integrity: a booking must reference a real, active patient. We
// check that explicitly before writing so a missing or soft-deleted patient
// yields a clean 404 Problem rather than a raw Prisma foreign-key error (which
// would surface as a 500). The DB-level `onDelete: Restrict` is the backstop.
//
// Soft delete: `deletedAt` marks a row as deleted without removing it, so the
// clinical record is retained (CLAUDE.md §4.2). Every read filters out
// soft-deleted rows.
import type { Appointment } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { HttpProblem } from '../../lib/problem.js';
import { hasActiveConsent } from '../consent/consent.service.js';
import type {
  CreateAppointmentInput,
  ListQuery,
  UpdateAppointmentInput,
} from './appointment.schema.js';

/** Only active (non-soft-deleted) rows are visible to the API. */
const ACTIVE = { deletedAt: null } as const;

/**
 * Guard that a patient exists and is active. Throws 404 (not a raw FK error) so
 * booking against a missing/soft-deleted patient fails gracefully. Called
 * before any write that sets `patientId`.
 */
async function assertPatientActive(patientId: string): Promise<void> {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, ...ACTIVE },
  });

  if (!patient) {
    throw new HttpProblem(
      404,
      'Not Found',
      `No patient with id ${patientId}; cannot book an appointment`,
    );
  }
}

/**
 * Book an appointment, after verifying the patient exists and is active AND has
 * granted the data-processing consent the Kenya Data Protection Act, 2019
 * requires before Elara Healthcare may process their data for a booking (#13).
 * Absent that consent the booking is refused with 422 — the patient is valid,
 * but the request is unprocessable until consent is on file. Only creation is
 * gated; updates to an existing booking are not.
 */
export async function createAppointment(
  input: CreateAppointmentInput,
): Promise<Appointment> {
  await assertPatientActive(input.patientId);

  if (!(await hasActiveConsent(input.patientId, 'DATA_PROCESSING'))) {
    throw new HttpProblem(
      422,
      'Consent Required',
      'Patient has not granted the data-processing consent required to book an appointment.',
    );
  }

  return prisma.appointment.create({ data: input });
}

/** Return one page of active appointments, newest first, with optional filters. */
export function listAppointments({
  limit,
  offset,
  patientId,
  status,
}: ListQuery): Promise<Appointment[]> {
  return prisma.appointment.findMany({
    where: {
      ...ACTIVE,
      ...(patientId ? { patientId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

/**
 * Fetch a single active appointment or throw 404. Centralising the "not found"
 * decision here keeps every caller (get/update/delete) consistent: a
 * soft-deleted or unknown id is indistinguishable to the client.
 */
export async function getAppointment(id: string): Promise<Appointment> {
  const appointment = await prisma.appointment.findFirst({
    where: { id, ...ACTIVE },
  });

  if (!appointment) {
    throw new HttpProblem(404, 'Not Found', `No appointment with id ${id}`);
  }

  return appointment;
}

/** Update an active appointment, or throw 404 if it is missing/soft-deleted. */
export async function updateAppointment(
  id: string,
  input: UpdateAppointmentInput,
): Promise<Appointment> {
  // Guard first so updating a soft-deleted/unknown id 404s rather than 500-ing.
  await getAppointment(id);

  // Re-pointing an appointment at a different patient must respect the same
  // referential-integrity rule as create.
  if (input.patientId !== undefined) {
    await assertPatientActive(input.patientId);
  }

  return prisma.appointment.update({ where: { id }, data: input });
}

/**
 * Soft delete: stamp `deletedAt` instead of removing the row. Returns nothing;
 * throws 404 if the appointment is already gone.
 */
export async function deleteAppointment(id: string): Promise<void> {
  await getAppointment(id);

  await prisma.appointment.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}
