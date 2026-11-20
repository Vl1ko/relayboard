// Autonomous capacity exercise: real PostgreSQL/runtime, simulated model and transports.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile,appendFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {applyAiManagerMigration} from '../dist-node/core/ai-manager-migration.js';
import {AiManagerStore} from '../dist-node/core/ai-manager.js';
import {AiExecutionRuntime} from '../dist-node/core/ai-execution-runtime.js';
import {ConversationWorkflow} from '../dist-node/core/conversation-workflow.js';
import {bindSourceRequest} from '../dist-node/core/request-lifecycle.js';
const url=new URL(process.env.AI_MANAGER_TEST_DATABASE_URL||'');if(url.pathname!='/relayboard_ai_manager_test')throw Error('Dedicated synthetic DB required');
const duration=Number(process.env.SOAK_DURATION_MS||86400000),interval=Number(process.env.SOAK_INTERVAL_MS||60000),rotation=Number(process.env.SOAK_ROTATION_MS||3600000);
if(!Number.isSafeInteger(duration)||duration<1000||!Number.isSafeInteger(interval)||interval<100||!Number.isSafeInteger(rotation)||rotation<interval)throw Error('Invalid soak limits');
const schema='soak_'+randomUUID().replaceAll('-',''),root=resolve(process.env.SOAK_OUTPUT_DIR||'outputs/res09-soak-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(root,{recursive:true});const admin=new pg.Pool({connectionString:url.toString()});await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');
const db=new pg.Pool({connectionString:url.toString(),max:25}),store=new AiManagerStore(db),workflow=new ConversationWorkflow(db),stop=new AbortController();process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
const started=Date.now(),deadline=started+duration,latencies=[],sends=new Map(),cases=[],dialogues={max:0,whatsapp:0};let cycles=0,requests=0,status='running',failure;
const provider={kind:'fixture',async complete(){return{replyDraft:'',extracted:[],replyKind:'ask_fields',askFields:['volume'],knowledgeKeys:[],proposedStatus:'insufficient_data',handoffReason:null};}};
const transport={allowsConversation:async()=>true,async dispatchAction(id,target){return store.dispatch(id,{target,start(a){sends.set(id,(sends.get(id)||0)+1);return{acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'confirmed',externalMessageId:'synthetic:'+id,code:'soak_confirmation',retryCondition:'never'})};}});},async dispatchNotification(){throw Error('Unexpected soak handoff');}};
let runtime=new AiExecutionRuntime(db,provider,transport,stop.signal);
async function sample(){const metrics=(await db.query(`SELECT (SELECT count(*)::int FROM ai_requests WHERE lifecycle='open') active_requests,(SELECT count(*)::int FROM ai_outbox WHERE state IN ('pending','dispatching')) queue,(SELECT count(*)::int FROM ai_outbox WHERE state='unknown') unknown,(SELECT pg_total_relation_size('ai_inbox'))::text inbox_bytes,(SELECT pg_total_relation_size('ai_outbox'))::text outbox_bytes,(SELECT pg_database_size(current_database()))::text database_bytes`)).rows[0];const memory=process.memoryUsage();await appendFile(root+'/metrics.jsonl',JSON.stringify({at:new Date().toISOString(),elapsedMs:Date.now()-started,cycles,requests,dialogues,...metrics,rss:memory.rss,heapUsed:memory.heapUsed,duplicateStarts:[...sends.values()].filter(n=>n>1).length})+'\n');return metrics;}
try{
 await db.query(await readFile(new URL('../database/schema.sql',import.meta.url),'utf8'));await applyAiManagerMigration(db);
 await db.query('UPDATE ai_engine_settings SET settings=settings||$1::jsonb',[JSON.stringify({qualificationEnabled:true,replyLimit:100,fields:[{key:'volume',question:'Какой объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);
 for(const platform of ['max','whatsapp'])for(let accountIndex=0;accountIndex<5;accountIndex++){
  const account=(await db.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES($1,$2,'synthetic-no-token') RETURNING id",[platform,'Soak '+platform+' '+accountIndex])).rows[0].id;
  for(let index=0;index<2;index++){const contact=await store.createContact('Synthetic soak '+platform+' '+accountIndex+' '+index),externalId=platform==='max'?String(200+accountIndex*2+index):String(200+accountIndex*2+index)+'@c.us',v=await store.createConversation({contactId:contact.id,accountId:account,externalId});cases.push({id:v.id,accountId:account,platform,externalId,lastRotation:0,generation:0});}
 }
 while(Date.now()<deadline&&!stop.signal.aborted){const cycleStart=performance.now();
  for(const v of cases)if(!v.lastRotation||Date.now()-v.lastRotation>=rotation){if(v.lastRotation)await workflow.setStatus({conversationId:v.id,status:'closed',reason:'Synthetic soak request rotation'});v.generation++;await bindSourceRequest(db,{conversationId:v.id,accountId:v.accountId,platform:v.platform,chatId:v.platform==='max'?'-500':'500@g.us',messageId:'synthetic-source-'+v.id+'-'+v.generation,authorId:v.externalId});v.lastRotation=Date.now();dialogues[v.platform]++;}
  await Promise.all(cases.map(v=>store.ingest({version:1,platform:v.platform,accountId:v.accountId,conversationId:v.externalId,messageId:'cycle-'+cycles,occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'Синтетическое уточнение без числового параметра'})));requests+=cases.length;
  if(cycles%10===0)runtime=new AiExecutionRuntime(db,provider,transport,stop.signal); // durable coordinator restart
  await runtime.tick();const metrics=await sample();assert.equal(metrics.active_requests,20);assert.equal(metrics.queue,0);assert.equal(metrics.unknown,0);assert.equal(sends.size,requests);assert.ok([...sends.values()].every(n=>n===1));
  latencies.push(performance.now()-cycleStart);cycles++;await writeFile(root+'/status.json',JSON.stringify({status,startedAt:new Date(started).toISOString(),updatedAt:new Date().toISOString(),requestedDurationMs:duration,elapsedMs:Date.now()-started,cycles,requests,dialogues,scope:'synthetic runtime; no browser profiles, messenger sends or model calls'},null,2)+'\n');
  try{await delay(Math.min(Math.max(0,interval-(performance.now()-cycleStart)),Math.max(0,deadline-Date.now())),undefined,{signal:stop.signal});}catch{break;}
 }
 status=stop.signal.aborted?'interrupted':'passed';
}catch(error){status='failed';failure=error instanceof Error?error.message:'Unknown soak failure';process.exitCode=1;}
finally{
 latencies.sort((a,b)=>a-b);const report={status,startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),requestedDurationMs:duration,elapsedMs:Date.now()-started,cycles,requests,dialogues,simulatedAccounts:{max:5,whatsapp:5},parallelRequests:20,duplicateStarts:[...sends.values()].filter(n=>n>1).length,p95CycleMs:latencies[Math.floor(latencies.length*.95)]??null,failure,full24Hours:status==='passed'&&duration>=86400000,scope:'synthetic runtime only; does not prove real Chromium/session or model capacity'};
 await writeFile(root+'/status.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
}
