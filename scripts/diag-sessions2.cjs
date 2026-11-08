const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgres://hospitality_app:hc_local_app_password@127.0.0.1:5432/hospitality_core' });

async function sha256(s) {
  const crypto = await import('crypto');
  const h = crypto.webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  // First, inspect the sessions table structure
  const { rows: cols } = await p.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'identity' AND table_name = 'sessions'
     ORDER BY ordinal_position`
  );
  console.log('identity.sessions columns:');
  for (const c of cols) console.log('  ' + c.column_name + ' (' + c.data_type + ')');

  // Get the token
  const token = require('fs').readFileSync('/tmp/demo-token.txt', 'utf8').trim();
  console.log('\nToken prefix:', token.substring(0, 12) + '...');

  // Look up the user
  const { rows: users } = await p.query(
    `SELECT id, email, display_name FROM identity.users WHERE email = $1`, ['admin@demo.local']
  );
  if (!users.length) { console.log('User not found'); await p.end(); return; }
  const userId = users[0].id;
  console.log('User id:', userId.substring(0, 8) + '...');

  // List sessions by user - try different column names
  const { rows: sessions } = await p.query(
    `SELECT * FROM identity.sessions WHERE user_id = $1 OR identity_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [userId]
  );
  console.log('\nSessions for user (' + sessions.length + '):');
  for (const s of sessions) {
    console.log('  ', JSON.stringify(s, null, 2).slice(0, 300));
  }

  // Try direct token lookup - the token might BE the session UUID
  const tokenAsUuid = token.toLowerCase();
  const { rows: byToken } = await p.query(
    `SELECT * FROM identity.sessions WHERE id = $1 OR token = $1 OR encode(id, 'hex') = $2 LIMIT 1`,
    [tokenAsUuid, token]
  );
  console.log('\nDirect token lookup:', byToken.length ? 'FOUND' : 'NOT FOUND');

  await p.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
