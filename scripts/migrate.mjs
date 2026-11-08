#!/usr/bin/env node
/**
 * Ordered, checksummed SQL migration runner.
 *
 * - Applies db/migrations/*.sql in filename order, once.
 * - Records a SHA-256 checksum per migration and refuses to run if an applied
 *   migration was edited afterwards (prevents drift between environments).
 * - Runs each migration inside its own transaction.
 * - `--dry-run` lists pending migrations.
 * - `--to <file>` stops after the named migration.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const toIndex = args.indexOf('--to');
const to = toIndex >= 0 ? args[toIndex + 1] : undefined;

const url =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/hospitality_core';

const dir = resolve(root, 'db/migrations');
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS platform_schema_migrations (
    filename text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL
  )
`);

const applied = new Map(
  (await client.query('SELECT filename, checksum FROM platform_schema_migrations')).rows.map((r) => [
    r.filename,
    r.checksum,
  ]),
);

let count = 0;
try {
  for (const file of files) {
    const sql = await readFile(resolve(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prior = applied.get(file);
    if (prior && prior !== checksum) {
      throw new Error(
        `Migration ${file} was modified after it was applied. Add a new migration instead of editing history.`,
      );
    }
    if (prior) continue;
    if (dryRun) {
      console.log(`pending: ${file}`);
      continue;
    }
    const started = Date.now();
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO platform_schema_migrations (filename, checksum, duration_ms) VALUES ($1,$2,$3)',
        [file, checksum, Date.now() - started],
      );
      await client.query('COMMIT');
      console.log(`applied: ${file} (${Date.now() - started}ms)`);
      count += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
    if (to && file === to) break;
  }
} finally {
  await client.end();
}

if (dryRun) console.log('Dry run complete.');
else console.log(count === 0 ? 'Database is up to date.' : `Applied ${count} migration(s).`);
