const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgres://hospitality_app:hc_local_app_password@127.0.0.1:5432/hospitality_core' });
const fs = require('fs');

async function sha256(s) {
  const crypto = await import('crypto');
  const h = crypto.webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  const token = fs.readFileSync('/tmp/demo-token.txt', 'utf8').trim();
  const tokenHash = await sha256(token);
  console.log('Token prefix:', token.substring(0, 12) + '...');
  console.log('Token hash:', tokenHash.substring(0, 16) + '...');

  // Get user id
  const { rows: users } = await p.query(
    `SELECT id, email FROM identity.users WHERE email = $1`, ['admin@demo.local']
  );
  if (!users.length) { console.log('User not found'); await p.end(); return; }
  const userId = users[0].id;
  console.log('User id:', userId);

  // List sessions by user_id
  const { rows: sessions } = await p.query(
    `SELECT id, token_hash, issued_at, last_seen_at, expires_at, revoked_at, ip_address
     FROM identity.sessions WHERE user_id = $1 ORDER BY issued_at DESC`,
    [userId]
  );
  console.log('\nSessions for user (' + sessions.length + '):');
  for (const s of sessions) {
    const match = s.token_hash === tokenHash ? ' <-- MATCHES SAVED TOKEN' : '';
    const expired = new Date(s.expires_at) < new Date() ? ' EXPIRED' : '';
    console.log(`  hash=${s.token_hash.substring(0,16)}..` +
      ` issued=${new Date(s.issued_at).toISOString()}` +
      ` expires=${new Date(s.expires_at).toISOString()}` +
      ` last_seen=${s.last_seen_at ? new Date(s.last_seen_at).toISOString() : 'null'}` +
      ` revoked=${s.revoked_at ? new Date(s.revoked_at).toISOString() : 'null'}` +
      ` ip=${s.ip_address}${match}${expired}`);
  }

  // Now check if the browser's token hash is in there - we need the browser token
  // Let's also check: does the API log show any successful auth for the browser IP?
  const { rows: recentAuth } = await p.query(
    `SELECT id, token_hash, issued_at, expires_at, last_seen_at, revoked_at, ip_address
     FROM identity.sessions
     WHERE ip_address::text = '18.227.98.11'
     ORDER BY issued_at DESC LIMIT 5`
  );
  console.log('\nSessions from browser IP (18.227.98.11):');
  for (const s of recentAuth) {
    console.log(`  hash=${s.token_hash.substring(0,16)}..` +
      ` issued=${new Date(s.issued_at).toISOString()}` +
      ` expires=${new Date(s.expires_at).toISOString()}` +
      ` last_seen=${s.last_seen_at ? new Date(s.last_seen_at).toISOString() : 'null'}` +
      ` revoked=${s.revoked_at ? new Date(s.revoked_at).toISOString() : 'null'}`);
  }

  await p.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
