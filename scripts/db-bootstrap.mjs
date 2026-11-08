#!/usr/bin/env node
/**
 * Creates the restricted runtime database role used by the API.
 *
 * The API must never connect as the schema owner: table owners bypass row level
 * security, which would silently disable tenant isolation. This script creates a
 * NOSUPERUSER / NOBYPASSRLS login role and grants it only what the runtime needs.
 *
 * Idempotent: safe to run on every deployment.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) {
  for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/hospitality_core';
const appUser = process.env.APP_DB_USER ?? 'hospitality_app';
const appPassword = process.env.APP_DB_PASSWORD;

if (!appPassword || appPassword.startsWith('CHANGE_ME')) {
  console.error(
    'APP_DB_PASSWORD is not set. Copy .env.example to .env and set a strong password, ' +
      'or export APP_DB_PASSWORD before running this script.',
  );
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]{2,62}$/.test(appUser)) {
  console.error(`Invalid APP_DB_USER: ${appUser}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appUser]);
  const literal = appPassword.replaceAll("'", "''");
  if (existing.rowCount === 0) {
    await client.query(
      `CREATE ROLE ${appUser} LOGIN PASSWORD '${literal}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    console.log(`Created restricted runtime role ${appUser}`);
  } else {
    await client.query(`ALTER ROLE ${appUser} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${literal}'`);
    console.log(`Updated restricted runtime role ${appUser}`);
  }
  await client.query(`GRANT CONNECT ON DATABASE ${client.database} TO ${appUser}`);
} finally {
  await client.end();
}
