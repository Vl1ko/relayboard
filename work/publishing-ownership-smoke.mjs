// Isolated PostgreSQL schema + unique Redis queue; no platform jobs or sends.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {Queue} from 'bullmq';
const url=new URL(process.env.AI_MANAGER_TEST_DATABASE_URL||'');
if(!url.pathname.endsWith('/relayboard_ai_manager_test'))throw Error('Dedicated synthetic database required');
const schema='publishing_owner_'+randomUUID().replaceAll('-','');
const admin=new pg.Pool({connectionString:url.toString()});
await admin.query('CREATE SCHEMA '+schema);
url.searchParams.set('options','-c search_path='+schema+',public');
const db=new pg.Pool({connectionString:url.toString()}),children=[];
const queueName='ownership-test-'+randomUUID();
const redis=new URL(process.env.REDIS_URL);
const queue=new Queue(queueName,{connection:{host:redis.hostname,port:Number(redis.port||6379)}});
function start(){
 const child=spawn(process.execPath,['dist-node/worker/index.js'],{env:{...process.env,DATABASE_URL:url.toString(),QUEUE_NAME:queueName},stdio:['ignore','pipe','pipe']});
 const record={child,output:'',error:'',ended:false};children.push(record);
 child.stdout.on('data',chunk=>record.output+=chunk);child.stderr.on('data',chunk=>record.error+=chunk);child.on('exit',()=>record.ended=true);return record;
}
async function until(check,label){const deadline=Date.now()+10000;while(Date.now()<deadline){if(await check())return;await delay(30);}throw Error(label);}
async function stop(record){if(record.ended)return;record.child.kill('SIGTERM');await until(()=>record.ended,'worker shutdown timed out');}
try{
 await db.query(await readFile(new URL('../database/schema.sql',import.meta.url),'utf8'));
 const first=start();await until(()=>first.output.includes('publishing worker started'),'first owner did not start');
 const account=(await db.query("INSERT INTO integrations(platform,name,credential_ciphertext,enabled) VALUES('max','synthetic','fake',false) RETURNING id")).rows[0].id;
 const destination=(await db.query("INSERT INTO destinations(integration_id,external_id,title) VALUES($1,'fake','synthetic') RETURNING id",[account])).rows[0].id;
 const post=(await db.query("INSERT INTO posts(text,mode,status) VALUES('synthetic','now','active') RETURNING id")).rows[0].id;
 const delivery=(await db.query("INSERT INTO deliveries(post_id,destination_id,occurrence_key,status) VALUES($1,$2,'synthetic','sending') RETURNING id",[post,destination])).rows[0].id;
 const second=start();await delay(400);
 assert.equal(second.output.includes('publishing worker started'),false);
 assert.equal((await db.query('SELECT status FROM deliveries WHERE id=$1',[delivery])).rows[0].status,'sending');
 await stop(first);await until(()=>second.output.includes('publishing worker started'),'next owner did not recover');
 assert.equal((await db.query('SELECT status FROM deliveries WHERE id=$1',[delivery])).rows[0].status,'unknown');
 await stop(second);
 assert.equal((await db.query('SELECT status FROM deliveries WHERE id=$1',[delivery])).rows[0].status,'unknown');
 console.log('PASS: second worker waits; only the next exclusive owner recovers interrupted sends as unknown; graceful shutdown releases ownership');
}finally{
 for(const record of children){if(!record.ended){record.child.kill('SIGTERM');try{await until(()=>record.ended,'shutdown');}catch{record.child.kill('SIGKILL');}}}
 await queue.obliterate({force:true});await queue.close();await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
}
