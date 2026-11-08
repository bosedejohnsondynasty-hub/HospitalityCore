const {Pool}=require('pg');
const p=new Pool({connectionString:'postgres://hospitality_app:hc_local_app_password@127.0.0.1:5432/hospitality_core'});
p.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  .then(r=>{r.rows.forEach(x=>console.log(x.tablename));p.end();})
  .catch(e=>{console.error(e.message);p.end();});
