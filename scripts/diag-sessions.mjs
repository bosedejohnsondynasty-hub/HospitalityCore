import pg from 'pg';
import { readFileSync } from 'fs';
import { webcrypto as crypto } from 'crypto';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://hospitality_app:hc_local_app_password@127.0.0.1:5432/hospitality_core',
  max: 1,
});

const sha256 = (s) => {
  const h = crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,'0')).join('');
};

const token = readFileSync('/tmp/demo-token.txt','utf8').trim();
const hash = await sha256(token);
console.log('Token:', token.substring(0,12)+'...');
console.log('Hash:', hash.substring(0,16)+'...');

const res = await pool.query(
  `SELECT id, issued_at, expires_at, last_seen_at, revoked_at
   FROM identity_sessions
   WHERE identity_id = (SELECT id FROM identities WHERE email=$1)
   ORDER BY issued_at DESC`,
  ['admin@demo.local']
);

console.log('\nSessions for admin@demo.local:');
for (const r of res.rows) {
  const idHash = await sha256(r.id);
  console.log(`  hash=${idHash.substring(0,16)}.. issued=${new Date(r.issued_at).toISOString()} expires=${new Date(r.expires_at).toISOString()} last_seen=${r.last_seen_at ? new Date(r.last_seen_at).toISOString() : 'null'} revoked=${r.revoked_at ? new Date(r.revoked_at).toISOString() : 'null'}`);
}
await pool.end();
