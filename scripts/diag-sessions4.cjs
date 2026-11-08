const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgres://hospitality_app:hc_local_app_password@127.0.0.1:5432/hospitality_core' });

async function main() {
  // List users table
  const { rows: cols } = await p.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'identity' AND table_name = 'users'
     ORDER BY ordinal_position`
  );
  console.log('identity.users columns:');
  for (const c of cols) console.log('  ' + c.column_name);

  // List all users
  const { rows: users } = await p.query(`SELECT * FROM identity.users`);
  console.log('\nAll users (' + users.length + '):');
  for (const u of users) {
    console.log('  id=' + u.id.substring(0,8) + '... email=' + u.email + ' tenant=' + u.tenant_id.substring(0,8) + '...');
  }

  // List sessions with user info
  const { rows: sessions } = await p.query(
    `SELECT s.id, s.token_hash, s.issued_at, s.expires_at, s.last_seen_at, s.revoked_at, s.ip_address, u.email
     FROM identity.sessions s JOIN identity.users u ON s.user_id = u.id
     ORDER BY s.issued_at DESC LIMIT 10`
  );
  console.log('\nRecent sessions (' + sessions.length + '):');
  for (const s of sessions) {
    const isExpired = new Date(s.expires_at) < new Date() ? ' EXPIRED' : '';
    console.log(`  user=${s.email} hash=${s.token_hash.substring(0,16)}..` +
      ` issued=${new Date(s.issued_at).toISOString()}` +
      ` expires=${new Date(s.expires_at).toISOString()}` +
      ` last_seen=${s.last_seen_at ? new Date(s.last_seen_at).toISOString() : 'null'}` +
      ` revoked=${s.revoked_at ? new Date(s.revoked_at).toISOString() : 'null'}` +
      ` ip=${s.ip_address}${isExpired}`);
  }

  await p.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
