#!/usr/bin/env node
/**
 * Applies db/seed/*.sql in filename order as the schema owner (bypasses RLS).
 * All seed statements are idempotent upserts, so this can run on every deploy.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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
const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const dir = resolve(root, 'db/seed');
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const file of files) {
    const sql = await readFile(resolve(dir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`seeded: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Seed ${file} failed: ${err.message}`);
    }
  }
} finally {
  await client.end();
}
