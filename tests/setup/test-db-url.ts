// Pure helper that derives the integration-test database URLs from DATABASE_URL.
//
// CRITICAL: this file imports nothing from the app — especially NOT
// src/config/env.ts. env.ts validates and FREEZES `process.env` at import time
// and (by design) never overrides an already-set DATABASE_URL. If this helper
// pulled it in, the dev URL would be locked before the test setup ever gets a
// chance to repoint DATABASE_URL at the test database. So we read the raw
// `process.env.DATABASE_URL` string directly and do nothing but string surgery.
//
// We swap only the database NAME, preserving host, port, credentials and query
// params (e.g. `?schema=public`). Two URLs come out of the same source:
//   - the test URL  -> the isolated `nexcare_test` database the suite runs on.
//   - the server URL -> the default maintenance `postgres` database, used once
//     in globalSetup to `CREATE DATABASE nexcare_test` (you cannot create a
//     database while connected to the database you are creating).

/** Name of the dedicated, isolated database the integration suite runs against. */
export const TEST_DATABASE_NAME = 'nexcare_test';

/** The default maintenance database every PostgreSQL server ships with. */
export const SERVER_DATABASE_NAME = 'postgres';

/** Read the raw connection string, failing loudly if it is absent. */
function sourceUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      'DATABASE_URL is not set; cannot derive the test database URL. ' +
        'Set it (locally via .env, in CI via the workflow env) before running tests.',
    );
  }
  return raw;
}

/** Return `rawUrl` with its database name swapped to `dbName`, query preserved. */
function withDatabaseName(rawUrl: string, dbName: string): string {
  const url = new URL(rawUrl);
  // URL.pathname is `/<dbname>`; replacing it leaves credentials and search intact.
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** Connection string for the isolated test database (`nexcare_test`). */
export function testDatabaseUrl(): string {
  return withDatabaseName(sourceUrl(), TEST_DATABASE_NAME);
}

/** Connection string for the server's maintenance database (`postgres`). */
export function serverDatabaseUrl(): string {
  return withDatabaseName(sourceUrl(), SERVER_DATABASE_NAME);
}
