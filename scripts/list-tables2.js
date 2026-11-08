const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgres://hospitality_app:hc_local_app_password@127.0.0.1:5432/hospitality_core' });
p.query(
  "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname, tablename"
).then(r => {
  for (const row of r.rows) console.log(row.schemaname + '.' + row.tablename);
  p.end();
}).catch(e => { console.error(e.message); p.end(); });
