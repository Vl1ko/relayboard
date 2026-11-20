// Disposable database only: exercise the actual read-only CLI, including historical false-ready regression.
import assert from 'node:assert/strict';import pg from 'pg';import {spawnSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'');if(url.hostname!=='postgres'||url.pathname!='/relayboard_rc_test'||process.env.AI_SEND_MODE!=='synthetic')throw Error('Disposable synthetic RC only');
function run(mode,database=url){const r=spawnSync(process.execPath,['dist-node/api/check-launch.js',mode],{env:{...process.env,DATABASE_URL:database.toString()},encoding:'utf8'});assert.ok([0,1].includes(r.status));return{code:r.status,data:JSON.parse(r.stdout)};}
const current=run('review');assert.equal(current.code,0);assert.equal(current.data.ready,true);assert.equal(current.data.liveAcceptance,false);
const live=run('live');assert.equal(live.code,1);assert.equal(live.data.ready,false);assert.equal(live.data.liveAcceptance,false);assert.ok(live.data.blockers.includes('AI_SEND_MODE must be live'));assert.equal(JSON.stringify(live.data).includes('transports are not implemented'),false);
const db=new pg.Pool({connectionString:url.toString()}),schema='preflight_'+randomUUID().replaceAll('-','');
try{
 await db.query('CREATE SCHEMA '+schema);await db.query('CREATE TABLE '+schema+'.ai_schema_migrations AS SELECT * FROM public.ai_schema_migrations WHERE version<=12');const isolated=new URL(url);isolated.searchParams.set('options','-c search_path='+schema+',public');
 const old=run('review',isolated);assert.equal(old.code,1);assert.ok(old.data.blockers.includes('Missing AI migration 23'));
 await db.query('TRUNCATE '+schema+'.ai_schema_migrations');await db.query('INSERT INTO '+schema+'.ai_schema_migrations SELECT * FROM public.ai_schema_migrations');await db.query("UPDATE "+schema+".ai_schema_migrations SET checksum='changed' WHERE version=1");assert.ok(run('review',isolated).data.blockers.includes('AI migration checksum mismatch 1'));
 console.log(JSON.stringify({result:'PASS',currentSchemaAcceptedForReview:true,schema12Rejected:true,changedChecksumRejected:true,incompleteLiveConfigurationRejected:true,liveAcceptanceAlwaysFalse:true,externalRequests:false}));
}finally{await db.query('DROP SCHEMA '+schema+' CASCADE');await db.end();}
