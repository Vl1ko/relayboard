// Real compiled worker processes; synthetic DB/provider/transport only.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {applyAiManagerMigration} from '../dist-node/core/ai-manager-migration.js';
const url=new URL(process.env.AI_MANAGER_TEST_DATABASE_URL||'');if(!url.pathname.endsWith('/relayboard_ai_manager_test'))throw Error('Dedicated synthetic DB required');
const schema='ai_execution_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.toString()});await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');
const db=new pg.Pool({connectionString:url.toString()}),children=[];
function start(overrides={}){const child=spawn(process.execPath,['dist-node/ai-worker/index.js'],{env:{...process.env,DATABASE_URL:url.toString(),AI_SEND_MODE:'synthetic',AI_PROVIDER_MODE:'fixture',AI_ALLOW_EXTERNAL_REQUESTS:'false',...overrides},stdio:['ignore','pipe','pipe']});const row={child,output:'',ended:false,code:null};children.push(row);child.stdout.on('data',c=>row.output+=c);child.stderr.on('data',c=>row.output+=c);child.on('exit',code=>{row.ended=true;row.code=code;});return row;}
async function until(check,label){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await check())return;await delay(30);}throw Error(label);}
try{
 await db.query(await readFile(new URL('../database/schema.sql',import.meta.url),'utf8'));await applyAiManagerMigration(db);
 for(const overrides of [
  {AI_SEND_MODE:'live'},
  {AI_SEND_MODE:'live',AI_PROVIDER_MODE:'gigachat',AI_ALLOW_EXTERNAL_REQUESTS:'true',GIGACHAT_AUTH_KEY:'synthetic-key',MAX_WORKER_URL:'http://127.0.0.1:1',MAX_WORKER_SECRET:randomBytes(32).toString('hex'),AI_TEST_ONLY:'true',AI_TEST_ACCOUNT_IDS:'',AI_TEST_AUTHOR_IDS:''},
  {NODE_ENV:'production',AI_SEND_MODE:'live',AI_PROVIDER_MODE:'gigachat',AI_ALLOW_EXTERNAL_REQUESTS:'true',GIGACHAT_AUTH_KEY:'synthetic-key',GIGACHAT_SCOPE:'GIGACHAT_API_PERS',MAX_WORKER_URL:'http://127.0.0.1:1',MAX_WORKER_SECRET:randomBytes(32).toString('hex'),AI_TEST_ONLY:'false'},
 ]){const denied=start(overrides);await until(()=>denied.ended,'invalid live config did not fail');assert.equal(denied.code,1);}
 assert.equal((await db.query('SELECT count(*)::int n FROM ai_engine_decisions')).rows[0].n,0);
 const account=(await db.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','synthetic','fake') RETURNING id")).rows[0].id;
 const contact=(await db.query("INSERT INTO ai_contacts(display_name) VALUES('synthetic') RETURNING id")).rows[0].id;
 const conversation=(await db.query("INSERT INTO ai_conversations(contact_id,account_id,platform,external_id,automation_mode) VALUES($1,$2,'max','303','auto') RETURNING id",[contact,account])).rows[0].id;
 await db.query("INSERT INTO ai_manager_target(id,account_id,external_id) VALUES(1,$1,'-456')",[account]);
 await db.query("INSERT INTO ai_inbox(event_key,conversation_id,external_message_id,occurred_at,direction,origin,disposition,text) VALUES('synthetic-event',$1,'one',now(),'inbound','customer','process_customer','synthetic question')",[conversation]);
 const first=start();await until(async()=>(await db.query("SELECT 1 FROM ai_handoff_notifications WHERE state='confirmed'")).rowCount===1,'synthetic handoff did not finish');
 const second=start();await delay(300);assert.equal(second.output.includes('AI worker: synthetic transport'),false);
 first.child.kill('SIGKILL');await until(()=>first.ended,'first owner kill');await until(()=>second.output.includes('AI worker: synthetic transport'),'second owner did not resume');
 await delay(150);assert.equal((await db.query('SELECT count(*)::int n FROM ai_engine_decisions')).rows[0].n,1);assert.equal((await db.query('SELECT count(*)::int n FROM ai_handoff_notifications')).rows[0].n,1);
 second.child.kill('SIGTERM');await until(()=>second.ended,'graceful shutdown');assert.equal(second.code,0);
 console.log('PASS: live config fails closed without provider/scope/commercial access; synthetic execution survives SIGKILL and second owner replays no decision or notification');
}finally{
 for(const row of children)if(!row.ended){row.child.kill('SIGTERM');try{await until(()=>row.ended,'shutdown');}catch{row.child.kill('SIGKILL');}}
 await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
}
