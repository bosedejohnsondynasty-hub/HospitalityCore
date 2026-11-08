import 'dotenv/config';
import pg from 'pg';

const p = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await p.connect();

// Find the demo tenant
const { rows: tenants } = await p.query(
  "SELECT id, tenant_code FROM platform.tenants WHERE tenant_code = 'demo'"
);
const demoTenantId = tenants[0]?.id;
console.log('Demo tenant:', demoTenantId?.substring(0,8) ?? 'NOT FOUND');

// Find the demo user
const { rows: users } = await p.query(
  `SELECT id, email FROM identity.users WHERE email = 'admin@demo.local'`
);
const demoUserId = users[0]?.id;
console.log('Demo user:', demoUserId?.substring(0,8) ?? 'NOT FOUND');

// Find sessions for demo user
const { rows: sessions } = await p.query(
  `SELECT id, token_hash, issued_at, expires_at, last_seen_at, revoked_at, ip_address
   FROM identity.sessions
   WHERE user_id = $1
   ORDER BY issued_at DESC`,
  [demoUserId]
);
console.log('\nDemo user sessions (' + sessions.length + '):');
for (const s of sessions) {
  const expired = new Date(s.expires_at) < new Date() ? ' EXPIRED' : '';
  const revoked = s.revoked_at ? ' REVOKED' : '';
  const idle = s.last_seen_at ? (new Date() - new Date(s.last_seen_at)) / 3600000 : null;
  const idleStr = idle !== null ? ` idle=${idle.toFixed(1)}h` : '';
  console.log(`  id=${s.id.substring(0,8)}..` +
    ` issued=${new Date(s.issued_at).toISOString()}` +
    ` expires=${new Date(s.expires_at).toISOString()}` +
    ` last_seen=${s.last_seen_at ? new Date(s.last_seen_at).toISOString() : 'never'}` +
    idleStr + expired + revoked +
    ` ip=${s.ip_address}`);
}

// Also get the browser's token from localStorage via... we can't directly.
// But we know the API log shows browser IP 18.227.98.11
console.log('\nSessions from browser IP 18.227.98.11:');
const { rows: byIp } = await p.query(
  `SELECT s.id, s.token_hash, s.issued_at, s.expires_at, s.last_seen_at, s.revoked_at, u.email
   FROM identity.sessions s
   JOIN identity.users u ON s.user_id = u.id
   WHERE s.ip_address::text = '18.227.98.11'
   ORDER BY s.issued_at DESC LIMIT 5`
);
for (const s of byIp) {
  const expired = new Date(s.expires_at) < new Date() ? ' EXPIRED' : '';
  const revoked = s.revoked_at ? ' REVOKED' : '';
  console.log(`  user=${s.email} id=${s.id.substring(0,8)}..` +
    ` hash=${s.token_hash.substring(0,16)}..` +
    ` issued=${new Date(s.issued_at).toISOString()}` +
    ` expires=${new Date(s.expires_at).toISOString()}` +
    ` last_seen=${s.last_seen_at ? new Date(s.last_seen_at).toISOString() : 'never'}` +
    expired + revoked);
}

// Now get the browser's actual token by reading localStorage from the page
// We know the token starts with "jmEl-ANvPx7r..."
// Let's hash it and look it up
const crypto = await import('crypto');
async function sha256(s) {
  const h = crypto.webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// The browser token - we need to get the full version from the browser
// For now, let's look for any unexpired, unrevoked session for the demo user
const validSession = sessions.find(s => 
  !s.revoked_at && new Date(s.expires_at) > new Date()
);
if (validSession) {
  console.log('\nValid (unexpired, unrevoked) session for demo user:');
  console.log('  id=' + validSession.id);
  console.log('  hash=' + validSession.token_hash);
  console.log('  issued=' + new Date(validSession.issued_at).toISOString());
  console.log('  expires=' + new Date(validSession.expires_at).toISOString());
} else {
  console.log('\nNo valid session found for demo user!');
}

await p.end();
