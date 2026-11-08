#!/usr/bin/env node
/**
 * Development database helper.
 *
 * Starts a real PostgreSQL cluster (embedded-postgres) for local development and
 * the automated test suite when a system PostgreSQL server is not available.
 * Production installs use the Docker Compose service instead; this script is a
 * developer convenience only and never runs in a customer deployment.
 *
 * Usage: node scripts/db-dev.mjs up|down|reset
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.PG_DATA_DIR
  ? resolve(root, process.env.PG_DATA_DIR)
  : resolve(root, '.pgdata');
const port = Number(process.env.PG_DEV_PORT ?? 5432);
const user = process.env.PG_DEV_USER ?? 'postgres';
const password = process.env.PG_DEV_PASSWORD ?? 'postgres';
const database = process.env.PG_DEV_DATABASE ?? 'hospitality_core';

function loadEnvFile() {
  const path = resolve(root, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnvFile();

const action = process.argv[2] ?? 'up';

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
  onError: (err) => console.error('[postgres]', err?.message ?? err),
});

async function up() {
  const fresh = !existsSync(`${dataDir}/PG_VERSION`);
  if (fresh) {
    console.log(`Initialising PostgreSQL cluster in ${dataDir}`);
    await pg.initialise();
  }
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE DATABASE ${JSON.stringify(database).replaceAll('"', '"')}`);
    console.log(`Created database ${database}`);
  }
  const version = await client.query('SHOW server_version');
  await client.end();
  console.log(
    `PostgreSQL ${version.rows[0].server_version} listening on 127.0.0.1:${port}, database ${database}`,
  );
  console.log('Cluster kept running by this process; press Ctrl+C to stop.');
  const shutdown = async () => {
    try {
      await pg.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Keep the process alive so the cluster stays available.
  setInterval(() => {}, 1 << 30);
}

async function down() {
  if (!existsSync(dataDir)) {
    console.log('No development cluster found.');
    return;
  }
  await pg.stop().catch(() => {});
  console.log('Development PostgreSQL stopped.');
}

async function reset() {
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
    console.log('Removed development cluster data directory.');
  }
  await up();
}

const actions = { up, down, reset };
if (!actions[action]) {
  console.error(`Unknown action: ${action}. Use up|down|reset`);
  process.exit(2);
}
await actions[action]();
