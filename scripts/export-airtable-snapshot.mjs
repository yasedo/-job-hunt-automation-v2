import fs from 'node:fs';
const token=process.env.AIRTABLE_TOKEN;
const base=process.env.AIRTABLE_BASE_ID||'appzNZgfYlDQnSZqG';
if(!token) throw new Error('Missing AIRTABLE_TOKEN');
const tables=['Jobs','Sources','Search Queries','Company Watchlist','Collection Runs'];
const out={exportedAt:new Date().toISOString(),baseId:base,tables:{}};
for(const table of tables){
  const rows=[]; let offset;
  do{
    const u=new URL(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`);
    u.searchParams.set('pageSize','100'); if(offset) u.searchParams.set('offset',offset);
    const r=await fetch(u,{headers:{Authorization:`Bearer ${token}`}});
    if(!r.ok) throw new Error(`${table}: ${r.status} ${await r.text()}`);
    const j=await r.json(); rows.push(...(j.records||[])); offset=j.offset;
  }while(offset);
  out.tables[table]=rows;
  console.log(`${table}: ${rows.length}`);
}
fs.mkdirSync('snapshot',{recursive:true});
fs.writeFileSync('snapshot/airtable_job_hunt_snapshot.json',JSON.stringify(out,null,2));
