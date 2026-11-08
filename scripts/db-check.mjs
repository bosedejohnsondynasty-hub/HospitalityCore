import 'dotenv/config';
import pg from 'pg';

const p = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await p.connect();

// Check all identity tables
const { rows: tables } = await p.query(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'identity' ORDER BY tablename"
);
console.log('identity tables:', tables.map(t => t.tablename).join(', ') || 'NONE');

// Check platform tenants
const { rows: tenants } = await p.query('SELECT tenant_code, tenant_name FROM platform.tenants ORDER BY tenant_code');
console.log('\nTenants (' + tenants.length + '):');
for (const t of tenants) console.log('  ' + t.tenant_code + ' = ' + t.tenant_name);

// Check identity.users 
const { rows: users } = await p.query('SELECT id, email, full_name, status, created_at FROM identity.users ORDER BY email');
console.log('\nUsers (' + users.length + '):');
for (const u of users) console.log('  ' + u.email + ' (' + u.full_name + ') status=' + u.status + ' created=' + u.created_at);

// Check identity.sessions
const { rows: sessions } = await p.query('SELECT count(*) as cnt FROM identity.sessions');
console.log('\nSessions count:', sessions[0]?.cnt ?? 0);

// Check workforce.employees
const { rows: emps } = await p.query('SELECT employee_number, full_name, status FROM workforce.employees ORDER BY employee_number');
console.log('\nEmployees (' + emps.length + '):');
for (const e of emps) console.log('  ' + e.employee_number + ' ' + e.full_name + ' (' + e.status + ')');

await p.end();
