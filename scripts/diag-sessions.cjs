const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgres://hospitality_app:hc_local_app_password@127.0.0.1:5432/hospitality_core' });

async function sha256(s) {
  const crypto = await import('crypto');
  const h = crypto.webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  const token = require('fs').readFileSync('/tmp/demo-token.txt', 'utf8').trim();
  const tokenHash = await sha256(token);
  console.log('Token prefix:', token.substring(0, 12) + '...');
  console.log('Token hash:', tokenHash.substring(0, 16) + '...');

  // List sessions for admin@demo.local
  const { rows: sessions } = await p.query(
    `SELECT id, issued_at, expires_at, last_seen_at, revoked_at
     FROM identity.sessions
     WHERE identity_id = (SELECT id FROM identity.users WHERE email = $1)
     ORDER BY issued_at DESC`,
    ['admin@demo.local']
  );

  console.log('\nSessions for admin@demo.local (' + sessions.length + '):');
  for (const s of sessions) {
    const idHash = await sha256(s.id);
    const match = idHash === tokenHash ? ' <-- MATCHES BROWSER TOKEN' : '';
    console.log(`  id=${s.id.substring(0,8)}.. hash=${idHash.substring(0,16)}..` +
      ` issued=${new Date(s.issued_at).toISOString()}` +
      ` expires=${new Date(s.expires_at).toISOString()}` +
      ` last_seen=${s.last_seen_at ? new Date(s.last_seen_at).toISOString() : 'null'}` +
      ` revoked=${s.revoked_at ? new Date(s.revoked_at).toISOString() : 'null'}` +
      match);
  }

  // Also check if browser token is in the sessions table at all
  const { rows: byHash } = await p.query(
    `SELECT id, issued_at, expires_at, last_seen_at, revoked_at
     FROM identity.sessions
     WHERE encode(id, 'hex') = $1
     LIMIT 1`,
    [token]  // token IS the session id (UUID)
  );
  console.log('\nSession lookup by token as UUID:', byHash.length ? 'FOUND' : 'NOT FOUND');

  await p.end();
}
main().catch(e => { console.error(e); process.exit(1); });
