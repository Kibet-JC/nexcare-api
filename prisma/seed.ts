// Dev database seed — populates Postgres with realistic synthetic patients and
// appointments in one command (`pnpm db:seed` or `prisma db seed`).
//
// This is a developer convenience, not a production operation. It is designed
// to be safe to run repeatedly: it TRUNCATEs the dev data tables first, then
// rebuilds a clean, deterministic-enough slate. The data is faker-generated and
// clearly synthetic — never seed real patient records.
//
// SAFETY: this script refuses to run when NODE_ENV is "production" (see
// `seedDatabase`), so it can never wipe a real clinical database.
import { fileURLToPath } from 'node:url';
import { faker } from '@faker-js/faker';
import { Prisma, type Sex, type AppointmentStatus } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { createUser } from '../src/modules/user/user.service.js';
import type { CreateUserInput } from '../src/modules/user/user.schema.js';

const PATIENT_COUNT = 10;

// Known dev login credentials so #11 (login) can sign in immediately after a
// seed. This is dev convenience only — the seed refuses to run in production
// (see `seedDatabase`), so these credentials never reach a real database. The
// password satisfies the user module's password policy.
const DEV_USER_PASSWORD = 'DevPassw0rd!2026';
const DEV_USERS: CreateUserInput[] = [
  {
    email: 'admin@elarahealthcare.co.ke',
    password: DEV_USER_PASSWORD,
    role: 'ADMIN',
    firstName: 'Dev',
    lastName: 'Admin',
  },
  {
    email: 'clinician@elarahealthcare.co.ke',
    password: DEV_USER_PASSWORD,
    role: 'CLINICIAN',
    firstName: 'Dev',
    lastName: 'Clinician',
  },
];
const SEXES: Sex[] = ['MALE', 'FEMALE', 'OTHER'];
const APPOINTMENT_STATUSES: AppointmentStatus[] = [
  'SCHEDULED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
];
const APPOINTMENT_REASONS = [
  'Initial consultation',
  'Follow-up review',
  'Antenatal check',
  'Wound dressing',
  'Lab results review',
  'Chronic care visit',
];

/**
 * A Kenyan-style E.164 mobile number (CLAUDE.md §4.2): `+2547` followed by 8
 * digits. Clearly synthetic — random, not allocated to any real subscriber.
 */
function kenyanPhone(): string {
  return `+2547${faker.string.numeric(8)}`;
}

/**
 * Build one synthetic patient. Names are faker-generated, the date of birth is
 * a plausible adult age, and sex is drawn from the full enum so seeded data
 * exercises every value.
 */
function buildPatient(): Prisma.PatientCreateInput {
  return {
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    dateOfBirth: faker.date.birthdate({ min: 1, max: 90, mode: 'age' }),
    sex: faker.helpers.arrayElement(SEXES),
    phone: kenyanPhone(),
  };
}

/**
 * Build a list of 0-3 appointments for a patient, with scheduledFor dates
 * spread across the recent past and near future and a varied status mix.
 */
function buildAppointments(patientId: string): Prisma.AppointmentCreateManyInput[] {
  const count = faker.number.int({ min: 0, max: 3 });

  return Array.from({ length: count }, () => ({
    patientId,
    // Range straddles "now" so seeded data has both history and upcoming visits.
    scheduledFor: faker.date.between({
      from: faker.date.recent({ days: 30 }),
      to: faker.date.soon({ days: 30 }),
    }),
    durationMinutes: faker.helpers.arrayElement([15, 30, 45, 60]),
    reason: faker.helpers.arrayElement(APPOINTMENT_REASONS),
    status: faker.helpers.arrayElement(APPOINTMENT_STATUSES),
  }));
}

/**
 * Reset and repopulate the dev database with synthetic patients and
 * appointments. Safe to run repeatedly — it truncates the data tables first.
 *
 * Refuses to run in production: the guard reads `process.env.NODE_ENV` at call
 * time (not the frozen `env` snapshot from import) so it always reflects the
 * live runtime, and protects a real database from being wiped.
 *
 * @returns the row counts inserted, for the caller to log or assert on.
 */
export async function seedDatabase(): Promise<{
  patients: number;
  appointments: number;
  users: number;
}> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to seed: NODE_ENV is "production". The seed truncates data ' +
        'and must never run against a real database.',
    );
  }

  // Clean slate for a repeatable seed. audit_logs has no FK to the others but is
  // cleared too so a reseed does not leave stale audit rows pointing at gone
  // entities. users stands alone (no FKs yet) but is cleared so dev accounts are
  // recreated cleanly each run. CASCADE + correct order keeps the FK from
  // appointments -> patients happy; RESTART IDENTITY resets sequences.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_logs", "appointments", "patients", "users" RESTART IDENTITY CASCADE',
  );

  const createdPatients = await Promise.all(
    Array.from({ length: PATIENT_COUNT }, () =>
      prisma.patient.create({ data: buildPatient() }),
    ),
  );

  const appointmentData = createdPatients.flatMap((patient) =>
    buildAppointments(patient.id),
  );
  const { count: appointmentCount } = await prisma.appointment.createMany({
    data: appointmentData,
  });

  // Dev staff accounts go through the user service so passwords are argon2id
  // hashed and the same policy/normalisation applies as in production code.
  for (const devUser of DEV_USERS) {
    await createUser(devUser);
  }

  // Log the dev credentials so #11 can log in. Safe to log: these are throwaway
  // dev accounts that never exist in a real database (the production guard
  // above). The shared password goes in the MESSAGE, not a structured field —
  // the logger redacts any `password` key (src/lib/logger.ts), which is the
  // correct behaviour for real requests and must not be weakened. We never log
  // argon2 hashes.
  logger.info(
    { users: DEV_USERS.map(({ email, role }) => ({ email, role })) },
    `Seeded dev users — log in (#11) with password: ${DEV_USER_PASSWORD}`,
  );

  const summary = {
    patients: createdPatients.length,
    appointments: appointmentCount,
    users: DEV_USERS.length,
  };
  logger.info(summary, 'Seed complete');
  return summary;
}

// Script entrypoint: run the seed, then always disconnect. Exit non-zero on any
// failure so `pnpm db:seed` / `prisma db seed` surfaces errors to the shell.
async function main(): Promise<void> {
  try {
    await seedDatabase();
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed directly (tsx prisma/seed.ts), not when imported. The
// test suite imports `seedDatabase`; running `main()` on import would seed and
// disconnect the shared Prisma client out from under it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    logger.error({ err: error }, 'Seed failed');
    process.exitCode = 1;
  });
}
