// Two compiled HTTP owners, isolated schema, synthetic identities, no MAX login.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {applyAiManagerMigration} from '../dist-node/core/ai-manager-migration.js';
const url=new URL(process.env.AI_MANAGER_TEST_DATABASE_URL||'');
if(!url.pathname.endsWith('/relayboard_ai_manager_test'))throw Error('Dedicated synthetic DB required');
const schema='max_owner_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.toString()});
await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');
const db=new pg.Pool({connectionString:url.toString()}),children=[],secret=randomBytes(32).toString('hex');
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const base='http://127.0.0.1:'+port,headers={authorization:'Bearer '+secret};
function start(){
 const child=spawn(process.execPath,['dist-node/messenger-worker/index.js'],{env:{...process.env,DATABASE_URL:url.toString(),MAX_WORKER_ENABLED:'true',MAX_WORKER_HOST:'127.0.0.1',MAX_WORKER_PORT:String(port),MAX_WORKER_SECRET:secret,AI_SEND_MODE:'disabled'},stdio:['ignore','pipe','pipe']});
 const row={child,output:'',ended:false};children.push(row);child.stdout.on('data',c=>row.output+=c);child.stderr.resume();child.on('exit',()=>row.ended=true);return row;
}
async function until(check,label){const deadline=Date.now()+10000;while(Date.now()<deadline){if(await check())return;await delay(30);}throw Error(label);}
async function stop(row){if(row.ended)return;row.child.kill('SIGTERM');await until(()=>row.ended,'shutdown timed out');}
try{
 await db.query(await readFile(new URL('../database/schema.sql',import.meta.url),'utf8'));await applyAiManagerMigration(db);
 const first=start();await until(()=>first.output.includes('MAX session owner listening'),'owner did not start');
 assert.equal((await fetch(base+'/health')).status,401);
 assert.equal((await fetch(base+'/health',{headers})).status,200);
 assert.equal((await fetch(base+'/actions/not-a-uuid/dispatch',{method:'POST',headers})).status,400);
 assert.equal((await fetch(base+'/accounts/'+randomUUID()+'/groups',{headers})).status,503);
 const contact=(await db.query("INSERT INTO ai_contacts(display_name) VALUES('synthetic') RETURNING id")).rows[0].id;
 const account=(await db.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','synthetic','not-a-real-token') RETURNING id")).rows[0].id;
 const conversation=(await db.query("INSERT INTO ai_conversations(contact_id,account_id,platform,external_id) VALUES($1,$2,'max','303') RETURNING id",[contact,account])).rows[0].id;
 const action=(await db.query("INSERT INTO ai_outbox(contact_id,conversation_id,logical_key,kind,text,fingerprint,automation_epoch,state,attempt_token) VALUES($1,$2,'synthetic','reply','synthetic','fake',0,'dispatching',$3) RETURNING id",[contact,conversation,randomUUID()])).rows[0].id;
 const second=start();await delay(350);assert.equal(second.output.includes('MAX session owner listening'),false);
 assert.equal((await db.query('SELECT state FROM ai_outbox WHERE id=$1',[action])).rows[0].state,'dispatching');
 first.child.kill('SIGKILL');await until(()=>first.ended,'killed owner did not exit');await until(()=>second.output.includes('MAX session owner listening'),'next owner did not start');
 assert.equal((await db.query('SELECT state FROM ai_outbox WHERE id=$1',[action])).rows[0].state,'unknown');
 assert.equal((await fetch(base+'/actions/'+action+'/dispatch',{method:'POST',headers})).status,503);
 await stop(second);assert.equal((await db.query('SELECT state FROM ai_outbox WHERE id=$1',[action])).rows[0].state,'unknown');
 console.log('PASS: authenticated MAX RPC, input validation, two-process ownership, SIGKILL recovery of interrupted AI send without login or resend');
}finally{
 for(const row of children)if(!row.ended){row.child.kill('SIGTERM');try{await until(()=>row.ended,'shutdown');}catch{row.child.kill('SIGKILL');}}
 await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
}
