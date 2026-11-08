const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgres://hospitality_app:hc_local_app_password@127.0.0.1:5432/hospitality_core' });

async function sha256(s) {
  const crypto = await import('crypto');
  const h = crypto.webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  // Browser token from earlier snapshot
  const browserToken = 'jmEl-ANvPx7r...'; // truncated - we need the full one
  // Actually let's get the full token from localStorage via the API
  // For now, query by IP address to find the session the browser used
  const token = require('fs').readFileSync('/tmp/demo-token.txt', 'utf8').trim();
  const tokenHash = await sha256(token);
  console.log('Saved token prefix:', token.substring(0, 12) + '...');
  console.log('Saved token hash:', tokenHash.substring(0, 16) + '...');

  // Find user
  const { rows: users } = await p.query(
    `SELECT id, email FROM identity.users WHERE email = $1`, ['admin@demo.local']
  );
  console.log('\nUsers found:', users.length);
  for (const u of users) console.log('  ' + u.email + ' id=' + u.id.substring(0,8) + '...');

  // Get all sessions with their user info - use the columns we know exist
  const { rows: sessions } = await p.query(
    `SELECT s.id, s.token_hash, s.issued_at, s.expires_at, s.last_seen_at, s.revoked_at, s.ip_address, u.email
     FROM identity.sessions s
     LEFT JOIN identity.users u ON s.user_id = u.id
     ORDER BY s.issued_at DESC`
  );
  console.log('\nAll sessions in DB (' + sessions.length + '):');
  for (const s of sessions) {
    const expired = new Date(s.expires_at) < new Date() ? ' EXPIRED' : '';
    const isSavedToken = s.token_hash === tokenHash ? ' <-- SAVED TOKEN' : '';
    console.log(`  user=${s.email || 'null'} hash=${s.token_hash.substring(0,16)}..` +
      ` issued=${new Date(s.issued_at).toISOString()}` +
      ` expires=${new Date(s.expires_at).toISOString()}` +
      ` last_seen=${s.last_seen_at ? new Date(s.last_seen_at).toISOString() : 'null'}` +
      ` revoked=${s.revoked_at ? new Date(s.revoked_at).toISOString() : 'null'}` +
      ` ip=${s.ip_address}${expired}${isSavedToken}`);
  }

  await p.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
