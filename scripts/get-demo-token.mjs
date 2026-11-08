import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';

const p = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await p.connect();

// Get the latest valid session's token hash for demo user
const { rows } = await p.query(
  `SELECT id, token_hash, issued_at, expires_at FROM identity.sessions
   WHERE user_id = (SELECT id FROM identity.users WHERE email = 'admin@demo.local')
   AND revoked_at IS NULL
   AND expires_at > NOW()
   ORDER BY issued_at DESC LIMIT 1`
);

if (!rows.length) {
  console.log('NO VALID SESSION');
  await p.end();
  process.exit(1);
}

const session = rows[0];
console.log('Session id:', session.id);
console.log('Token hash:', session.token_hash);
console.log('Expires:', new Date(session.expires_at).toISOString());

// The token IS the session UUID. Write it to /tmp/demo-token.txt
const token = session.id;
await import('fs').then(fs => fs.writeFileSync('/tmp/demo-token.txt', token));
console.log('\nToken saved to /tmp/demo-token.txt');
console.log('Token value:', token);

await p.end();
