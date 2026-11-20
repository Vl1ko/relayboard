import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {applyAiManagerMigration} from './ai-manager-migration.js';
import {SourceMonitor,sourceAssessmentSchema,type SourceScorer} from './source-monitor.js';
import {SourceMonitorSettings} from './source-monitor-settings.js';
import {activateSource} from './source-activation.js';
import {AiManagerStore} from './ai-manager.js';
import {AiOrchestrator} from './ai-orchestrator.js';
const url=process.env.SEARCH_TEST_DATABASE_URL,skip=!url;let pool:pg.Pool,schema:string,settings:SourceMonitorSettings;
before(async()=>{if(!url)return;if(new URL(url).pathname!='/relayboard_search_test')throw Error('Dedicated search test DB required');schema='monitor_'+randomUUID().replaceAll('-','');const c=new pg.Client({connectionString:url});await c.connect();await c.query('CREATE SCHEMA '+schema);await c.end();pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema+',public'});await pool.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));await applyAiManagerMigration(pool);settings=new SourceMonitorSettings(pool);});
beforeEach(async()=>{if(!pool)return;await pool.query('TRUNCATE ai_contacts,integrations,ai_source_messages,ai_leads,ai_source_cursors,ai_chat_criteria CASCADE');await pool.query('DELETE FROM ai_search_sources');await pool.query("INSERT INTO ai_source_runtime_status(role,enabled) SELECT unnest(ARRAY['coordinator','max-reader','whatsapp-reader']),true ON CONFLICT(role) DO UPDATE SET enabled=true,heartbeat_at=clock_timestamp()");await pool.query("UPDATE ai_monitor_settings SET mode='stopped',revision=0,epoch=0,started_at=NULL,settings=$1",[JSON.stringify({instructions:'Искать заявки на покупку щебня',includeTerms:[],excludeTerms:['продам'],confidenceThreshold:0.9,autoContact:true})]);await pool.query('UPDATE ai_engine_settings SET settings=settings||$1::jsonb',[JSON.stringify({provider:'gigachat',model:'GigaChat',qualificationEnabled:true,fields:[{key:'volume',question:'Объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);});
after(async()=>{if(pool){await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}});
async function fixture(){const accountId=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','Synthetic','fake') RETURNING id")).rows[0].id;await pool.query("INSERT INTO ai_search_sources(account_id,platform,chat_id) VALUES($1,'max','-10')",[accountId]);await pool.query("UPDATE ai_outreach_settings SET account_ids=$1",[[accountId]]);const policy=await settings.control({expectedRevision:0,action:'start'}),scope={testOnly:true,accountIds:[accountId],authorIds:['200']},monitor=new SourceMonitor(pool,scope),event={platform:'max' as const,accountId,chatId:'-10',authorId:'200',messageId:'source',occurredAt:new Date(new Date(policy.started_at).getTime()+1).toISOString(),text:'Нужно 12 тонн щебня',selfAuthorIds:['100']};return{accountId,policy,scope,monitor,event};}
const demand={intent:'demand',confidence:0.95,demandQuote:'Нужно 12 тонн щебня',params:[{key:'volume',value:12,evidenceQuote:'12 тонн'}]};
const scorer:SourceScorer={async complete(){return demand;}};
test('monitor captures one durable source and one grounded lead under twenty concurrent copies',{skip},async()=>{
 const f=await fixture(),captured=await Promise.all(Array.from({length:20},()=>f.monitor.capture(f.event)));assert.equal(captured.filter(r=>r.captured).length,1);const id=captured[0].id!;let calls=0;
 const results=await Promise.all(Array.from({length:20},()=>f.monitor.classify(id,{async complete(){calls++;return demand;}},new AbortController().signal)));assert.equal(calls,1);assert.equal(results.filter(r=>r.classified).length,1);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_leads')).rows[0].n,1);
 const row=(await pool.query('SELECT * FROM ai_source_messages WHERE id=$1',[id])).rows[0];assert.equal(row.original_text,null);assert.equal(row.state,'classified');assert.equal((await pool.query('SELECT original_text FROM ai_leads')).rows[0].original_text,f.event.text);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_outbox')).rows[0].n,0);
 await assert.rejects(f.monitor.capture({...f.event,text:'changed'}),/content_conflict/);
});
test('monitor scope, own sender, pre-start history and unselected chat never capture or call model',{skip},async()=>{
 const f=await fixture();for(const value of [{...f.event,accountId:randomUUID()},{...f.event,authorId:'300'},{...f.event,authorId:'100'},{...f.event,chatId:'other'},{...f.event,occurredAt:'2000-01-01T00:00:00Z'}])assert.equal((await f.monitor.capture(value)).captured,false);
 assert.equal((await f.monitor.pending()).length,0);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_source_messages')).rows[0].n,0);
});
test('excluded terms and irrelevant assessment retain only minimal dedup without message text',{skip},async()=>{
 const f=await fixture(),ignored=await f.monitor.capture({...f.event,text:'Продам щебень'});assert.equal(ignored.state,'ignored');assert.equal((await pool.query('SELECT original_text FROM ai_source_messages')).rows[0].original_text,null);
 const captured=await f.monitor.capture({...f.event,messageId:'other'});await f.monitor.classify(captured.id!,{async complete(){return{intent:'other',confidence:0.1,demandQuote:'',params:[]};}},new AbortController().signal);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_leads')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_source_messages WHERE original_text IS NOT NULL')).rows[0].n,0);
});
test('ambiguous and below-threshold sources remain reviewable but never auto-eligible',{skip},async()=>{
 const f=await fixture();for(const [i,result] of [{...demand,confidence:0.7},{...demand,intent:'ambiguous',confidence:1}].entries()){const captured=await f.monitor.capture({...f.event,messageId:String(i)});const scored=await f.monitor.classify(captured.id!,{async complete(){return result;}},new AbortController().signal);assert.equal(scored.autoEligible,false);assert.ok(scored.leadId);}
 assert.equal((await pool.query("SELECT count(*)::int n FROM ai_leads WHERE status='pending'")).rows[0].n,2);
});
test('fabricated demand quote, parameter evidence or unknown field fail closed and remain pending',{skip},async()=>{
 const f=await fixture();for(const [i,result] of [{...demand,demandQuote:'fabricated'},{...demand,params:[{key:'volume',value:100,evidenceQuote:'12 тонн'}]},{...demand,params:[{key:'invented',value:12,evidenceQuote:'12 тонн'}]}].entries()){const captured=await f.monitor.capture({...f.event,messageId:String(i)});await assert.rejects(f.monitor.classify(captured.id!,{async complete(){return result;}},new AbortController().signal));}
 assert.equal((await pool.query('SELECT count(*)::int n FROM ai_leads')).rows[0].n,0);assert.equal((await pool.query("SELECT count(*)::int n FROM ai_source_messages WHERE state='pending' AND retry_after IS NOT NULL")).rows[0].n,3);assert.equal(sourceAssessmentSchema.safeParse({...demand,confidence:100}).success,false);
});
test('settings revision during model call discards stale score; pause preserves queue and stop clears text',{skip},async()=>{
 const f=await fixture(),captured=await f.monitor.capture(f.event);let release!:(v:unknown)=>void,entered!:()=>void;const wait=new Promise(r=>release=r),ready=new Promise<void>(r=>entered=r);
 const work=f.monitor.classify(captured.id!,{complete(){entered();return wait;}},new AbortController().signal);await ready;const changed=await settings.save({expectedRevision:f.policy.revision,settings:{...f.policy.settings,confidenceThreshold:0.99}});release(demand);assert.equal((await work).classified,false);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_leads')).rows[0].n,0);
 const paused=await settings.control({expectedRevision:changed.revision,action:'pause'});assert.equal((await f.monitor.pending()).length,0);assert.ok((await pool.query('SELECT original_text FROM ai_source_messages')).rows[0].original_text);
 const stopped=await settings.control({expectedRevision:paused.revision,action:'stop'});assert.equal((await pool.query('SELECT original_text FROM ai_source_messages')).rows[0].original_text,null);const restarted=await settings.control({expectedRevision:stopped.revision,action:'start'});assert.notEqual(restarted.epoch,f.policy.epoch);assert.equal((await f.monitor.pending()).length,0);
});
test('monitor starts with more than five chats but still rejects duplicate readers',{skip},async()=>{
 const f=await fixture(),stopped=await settings.control({expectedRevision:f.policy.revision,action:'stop'});
 for(let i=0;i<20;i++)await pool.query("INSERT INTO ai_search_sources(account_id,platform,chat_id) VALUES($1,'max',$2)",[f.accountId,'-'+(20+i)]);const started=await settings.control({expectedRevision:stopped.revision,action:'start'});assert.equal(started.mode,'active');const paused=await settings.control({expectedRevision:started.revision,action:'pause'});
 await pool.query("DELETE FROM ai_search_sources WHERE chat_id<>'-10'");const other=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','Other','fake') RETURNING id")).rows[0].id;await pool.query("INSERT INTO ai_search_sources(account_id,platform,chat_id) VALUES($1,'max','-10')",[other]);await assert.rejects(settings.control({expectedRevision:paused.revision,action:'start'}),/duplicate_reader/);
});


async function activatedRoute(f:Awaited<ReturnType<typeof fixture>>,event=f.event,dialogId='303',assessment=demand){
 const captured=await f.monitor.capture(event),scored=await f.monitor.classify(captured.id!,{async complete(){return assessment;}},new AbortController().signal),store=new AiManagerStore(pool),contact=await store.createContact('Synthetic source author'),v=await store.createConversation({contactId:contact.id,accountId:f.accountId,externalId:dialogId});
 await pool.query(`INSERT INTO ai_verified_routes(conversation_id,account_id,platform,external_id,recipient_id,contact_id) VALUES($1,$2,'max',$3,$4,$5)`,[v.id,f.accountId,dialogId,event.authorId,contact.id]);
 await pool.query("UPDATE ai_outreach_settings SET account_ids=$1,platforms='{max}',interval_seconds=60",[[f.accountId]]);
 return{leadId:scored.leadId!,revision:0,contactId:contact.id,conversationId:v.id,accountId:f.accountId,platform:'max' as const,dialogId,recipientId:event.authorId,sourceAccountId:f.accountId,sourcePlatform:'max' as const,sourceChatId:event.chatId,messageId:event.messageId,authorId:event.authorId,text:event.text};
}
const reply={kind:'fixture' as const,async complete(){return{replyDraft:'',extracted:[],replyKind:'ask_fields',askFields:['volume'],knowledgeKeys:[],proposedStatus:'ai_dialog',handoffReason:null};}};
test('twenty source approvals commit one request and inbox; approved replay after close never creates a new request',{skip},async()=>{
 const f=await fixture(),route=await activatedRoute(f);const results=await Promise.all(Array.from({length:20},()=>activateSource(pool,f.scope,route,'automatic')));assert.equal(results.filter(r=>r.activated).length,1);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_requests')).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_inbox')).rows[0].n,1);
 await pool.query("UPDATE ai_conversations SET business_status='closed' WHERE id=$1",[route.conversationId]);assert.equal((await activateSource(pool,f.scope,route,'automatic')).replayed,true);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_requests')).rows[0].n,1);
});
test('source approval and first inbox roll back together; changed/rejected source cannot activate',{skip},async()=>{
 const f=await fixture(),route=await activatedRoute(f);await pool.query(`CREATE FUNCTION fail_source_inbox() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic inbox failure'; END$$;CREATE TRIGGER fail_source_inbox BEFORE INSERT ON ai_inbox FOR EACH ROW EXECUTE FUNCTION fail_source_inbox()`);
 try{await assert.rejects(activateSource(pool,f.scope,route,'automatic'),/synthetic inbox failure/);}finally{await pool.query('DROP TRIGGER fail_source_inbox ON ai_inbox;DROP FUNCTION fail_source_inbox()');}
 assert.equal((await pool.query('SELECT status FROM ai_leads WHERE id=$1',[route.leadId])).rows[0].status,'pending');assert.equal((await pool.query('SELECT count(*)::int n FROM ai_requests')).rows[0].n,0);
 await assert.rejects(activateSource(pool,f.scope,{...route,text:'changed'},'automatic'),/route_changed/);await pool.query("UPDATE ai_leads SET status='rejected',revision=revision+1 WHERE id=$1",[route.leadId]);await assert.rejects(activateSource(pool,f.scope,route,'automatic'),/lead_changed/);
});
test('source first AI reply obeys monitor pause/stop and the shared account interval',{skip},async()=>{
 const f=await fixture(),route=await activatedRoute(f,f.event,'303',{...demand,params:[]});await activateSource(pool,f.scope,route,'automatic');const orchestrator=new AiOrchestrator(pool),event=(await orchestrator.pending())[0],result=await orchestrator.process(event.conversation_id,event.event_key,reply);assert.ok(result.action);const store=new AiManagerStore(pool);
 const paused=await settings.control({expectedRevision:f.policy.revision,action:'pause'});assert.equal((await store.preflight(result.action.id)).ready,false);
 await settings.control({expectedRevision:paused.revision,action:'start'});
 await pool.query('INSERT INTO ai_outreach_clocks(account_id,last_started_at) VALUES($1,now())',[f.accountId]);assert.equal((await store.preflight(result.action.id)).ready,false);await pool.query("UPDATE ai_outreach_clocks SET last_started_at=now()-interval '1 day'");
 let starts=0;await store.dispatch(result.action.id,{target:{accountId:f.accountId,externalConversationId:route.dialogId,platform:'max'},start:a=>{starts++;return{acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'confirmed',externalMessageId:'synthetic-source-receipt',code:'synthetic',retryCondition:'never'})};}});assert.equal(starts,1);assert.equal((await pool.query('SELECT state FROM ai_outbox WHERE id=$1',[result.action.id])).rows[0].state,'confirmed');assert.ok(Date.now()-new Date((await pool.query('SELECT last_started_at FROM ai_outreach_clocks WHERE account_id=$1',[f.accountId])).rows[0].last_started_at).getTime()<10000);
});
test('source first qualification result uses the same pause gate; stop prevents later dispatch',{skip},async()=>{
 const f=await fixture(),route=await activatedRoute(f);await activateSource(pool,f.scope,route,'automatic');const orchestrator=new AiOrchestrator(pool),event=(await orchestrator.pending())[0];
 const result=await orchestrator.process(event.conversation_id,event.event_key,{kind:'fixture',async complete(input){return{replyDraft:'',extracted:[{field:'volume',value:12,evidenceMessageId:input.data.messages.find(m=>m.origin==='customer')!.messageId,evidenceQuote:'12 тонн'}],replyKind:'none',askFields:[],knowledgeKeys:[],proposedStatus:'qualified',handoffReason:null};}});
 const store=new AiManagerStore(pool),notice=await store.enqueueQualificationNotice(result.decision.id),stopped=await settings.control({expectedRevision:f.policy.revision,action:'stop'});assert.equal(stopped.mode,'stopped');assert.equal((await store.preflight(notice.id)).state,'cancelled');
});

test('MAX source cursor catches 250 messages and restart deduplicates them without any send',{skip},async()=>{
 const {MaxSourcePoller}=await import('./max-source-poller.js'),{MaxConnections}=await import('./max-connections.js'),{encryptCredentials}=await import('./crypto.js');
 const f=await fixture();await pool.query('UPDATE integrations SET credential_ciphertext=$2 WHERE id=$1',[f.accountId,encryptCredentials({token:'synthetic'})]);const base=new Date(f.policy.started_at).getTime();let historyCalls=0;
 const messages=Array.from({length:250},(_,i)=>({id:String(i+1),sender:200,time:base+i+1,type:'USER',text:'Нужно 12 тонн щебня'})),stop=new AbortController();
 const connections=new MaxConnections(pool,stop.signal,async()=>({selfId:100,groups:[],close(){},socket:{connected:true,async send(op,body){if(op===48)return{chats:[{id:-10,type:'CHAT'}]};assert.equal(op,49);historyCalls++;return{messages:messages.filter(m=>m.time<=Number(body.from)).sort((a,b)=>b.time-a.time).slice(0,100)};}}}));
 try{
  const poller=()=>new MaxSourcePoller(pool,connections,stop.signal,f.scope,()=>base+1000);assert.equal((await poller().poll(f.accountId,'-10')).complete,true);assert.ok(historyCalls>=3);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_source_messages')).rows[0].n,250);
  await poller().poll(f.accountId,'-10');assert.equal((await pool.query('SELECT count(*)::int n FROM ai_source_messages')).rows[0].n,250);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_outbox')).rows[0].n,0);
 }finally{stop.abort();}
});
test('MAX source gap retains cursor and denied test account never connects',{skip},async()=>{
 const {MaxSourcePoller}=await import('./max-source-poller.js'),{MaxConnections}=await import('./max-connections.js'),{encryptCredentials}=await import('./crypto.js');
 const f=await fixture();await pool.query('UPDATE integrations SET credential_ciphertext=$2 WHERE id=$1',[f.accountId,encryptCredentials({token:'synthetic'})]);const base=new Date(f.policy.started_at).getTime(),stop=new AbortController();let opens=0;
 const connections=new MaxConnections(pool,stop.signal,async()=>{opens++;return{selfId:100,groups:[],close(){},socket:{connected:true,async send(op){if(op===48)return{chats:[{id:-10,type:'CHAT'}]};return{messages:Array.from({length:100},(_,i)=>({id:String(i),sender:200,time:base+1000,text:'Нужно 12 тонн',type:'USER'}))};}}};});
 try{
  assert.equal((await new MaxSourcePoller(pool,connections,stop.signal,{...f.scope,accountIds:[]}).poll(f.accountId,'-10')).complete,false);assert.equal(opens,0);
  await assert.rejects(new MaxSourcePoller(pool,connections,stop.signal,f.scope,()=>base+1000).poll(f.accountId,'-10'),/page_stalled/);const cursor=(await pool.query('SELECT * FROM ai_source_cursors')).rows[0];assert.equal(Number(cursor.through_time),base-1);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_source_messages')).rows[0].n,0);
 }finally{stop.abort();}
});


test('source runtime restarts after score and activates one request without duplicate model evaluation',{skip},async()=>{
 const {SourceRuntime}=await import('./source-runtime.js');const f=await fixture(),route=await activatedRoute(f);let modelCalls=0,resolves=0;
 const runtime=()=>new SourceRuntime(pool,f.scope,{async complete(){modelCalls++;return demand;}},async id=>{resolves++;assert.equal(id,route.leadId);return route;},new AbortController().signal);
 await runtime().tick();await runtime().tick();assert.equal(modelCalls,0);assert.equal(resolves,1);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_requests')).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_inbox')).rows[0].n,1);
});


test('pending source queue is bounded without losing cursor progress or breaking duplicate replay',{skip},async()=>{
 const f=await fixture(),bounded=new SourceMonitor(pool,f.scope,2);await bounded.capture(f.event);await bounded.capture({...f.event,messageId:'second'});assert.equal((await bounded.capture(f.event)).replayed,true);await assert.rejects(bounded.capture({...f.event,messageId:'third'}),/capture_capacity/);assert.equal((await pool.query("SELECT count(*)::int n FROM ai_source_messages WHERE state='pending'")).rows[0].n,2);
});
test('opt-out after source capture prevents the next external classification request',{skip},async()=>{
 const {bindRemoteIdentity}=await import('./remote-identities.js');const f=await fixture(),captured=await f.monitor.capture(f.event),identity=await bindRemoteIdentity(pool,{platform:'max',remoteUserId:f.event.authorId,accountId:f.accountId,verificationKind:'source_author'});await new AiManagerStore(pool).optOut(identity.contactId,'stop');let calls=0;
 await f.monitor.classify(captured.id!,{async complete(){calls++;return demand;}},new AbortController().signal);assert.equal(calls,0);assert.equal((await pool.query('SELECT original_text FROM ai_source_messages WHERE id=$1',[captured.id])).rows[0].original_text,null);
});


async function waFixture(){
 const f=await fixture(),reader=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('whatsapp','Reader','fake') RETURNING id")).rows[0].id,sender=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('whatsapp','Sender','fake') RETURNING id")).rows[0].id;
 await pool.query("INSERT INTO ai_search_sources(account_id,platform,chat_id) VALUES($1,'whatsapp','10@g.us')",[reader]);await pool.query("UPDATE ai_outreach_settings SET account_ids=$1,platforms='{whatsapp}',interval_seconds=1",[[sender,reader]]);
 const scope={testOnly:true,accountIds:[reader,sender],authorIds:['200@lid','79990000123@c.us']},monitor=new SourceMonitor(pool,scope),timestamp=Math.floor(new Date(f.policy.started_at).getTime()/1000)+1,event={platform:'whatsapp' as const,accountId:reader,chatId:'10@g.us',authorId:'200@lid',messageId:'wa-source',occurredAt:new Date(timestamp*1000).toISOString(),text:'Нужно 12 тонн щебня',selfAuthorIds:['100@c.us']};
 return{...f,reader,sender,scope,monitor,event,timestamp};
}
test('WhatsApp group catch-up preserves same-second messages, service own messages and restart dedup',{skip},async()=>{
 const {WhatsAppSourcePoller}=await import('./whatsapp-source-poller.js');const f=await waFixture(),messages=Array.from({length:250},(_,i)=>({id:String(i),chatId:f.event.chatId,authorId:f.event.authorId,fromMe:false,timestamp:f.timestamp,text:f.event.text,type:'chat'}));
 messages.push({...messages[0],id:'own',authorId:'100@c.us',fromMe:true});const reader=async()=>({chatId:f.event.chatId,isGroup:true,selfAliases:['100@c.us'],exhausted:true,messages}),poller=()=>new WhatsAppSourcePoller(pool,reader,new AbortController().signal,f.scope,()=>f.timestamp*1000+1000);
 await poller().poll(f.reader,f.event.chatId);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_source_messages')).rows[0].n,250);await poller().poll(f.reader,f.event.chatId);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_source_messages')).rows[0].n,250);
 const gap=new WhatsAppSourcePoller(pool,async()=>({...await reader(),exhausted:false,messages:messages.map(m=>({...m,timestamp:f.timestamp+100}))}),new AbortController().signal,f.scope,()=>f.timestamp*1000+200000);await assert.rejects(gap.poll(f.reader,f.event.chatId),/backfill_limit/);assert.equal(Number((await pool.query("SELECT through_time FROM ai_source_cursors WHERE platform='whatsapp'")).rows[0].through_time),f.timestamp*1000+1000);
});
test('WhatsApp source reader and chosen sender use attested PN/LID to contact the original author privately',{skip},async()=>{
 const {resolveWhatsAppSourceRoute}=await import('./whatsapp-source-route.js');const f=await waFixture(),captured=await f.monitor.capture(f.event),scored=await f.monitor.classify(captured.id!,scorer,new AbortController().signal);let reads=0,resolves=0;
 const source={messageId:f.event.messageId,authorId:f.event.authorId,chatId:f.event.chatId,text:f.event.text,occurredAt:f.event.occurredAt,pn:'79990000123@c.us',aliases:['79990000123@c.us','200@lid'],selfAliases:['100@c.us']};
 const connections={async readSource(id:string){reads++;assert.equal(id,f.reader);return source;},async resolveRecipient(id:string){resolves++;assert.equal(id,f.sender);return{privateId:'201@lid',recipientId:'79990000123@c.us',pn:'79990000123@c.us',aliases:['79990000123@c.us','201@lid'],selfAliases:['300@c.us']};}};
 const route=await resolveWhatsAppSourceRoute(pool,connections,f.scope,{leadId:scored.leadId!,accountId:f.sender});assert.equal(reads,1);assert.equal(resolves,1);assert.equal(route.accountId,f.sender);assert.equal(route.sourceAccountId,f.reader);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_requests')).rows[0].n,0);
 await activateSource(pool,f.scope,route,'automatic');const saved=(await pool.query('SELECT * FROM ai_request_sources WHERE lead_id=$1',[route.leadId])).rows[0];assert.equal(saved.reader_account_id,f.reader);assert.equal(saved.account_id,f.sender);assert.equal(saved.author_id,'200@lid');assert.equal(saved.recipient_id,'79990000123@c.us');assert.equal((await pool.query('SELECT phone_e164 FROM ai_contacts WHERE id=$1',[route.contactId])).rows[0].phone_e164,'+79990000123');
 await assert.rejects(resolveWhatsAppSourceRoute(pool,{...connections,async readSource(){return{...source,text:'changed'};}},f.scope,{leadId:route.leadId,accountId:f.sender}),/source_changed/);
});


test('missing reader heartbeat holds source first reply without affecting its accepted decision',{skip},async()=>{
 const f=await fixture(),route=await activatedRoute(f,f.event,'303',{...demand,params:[]});await activateSource(pool,f.scope,route,'automatic');const orchestrator=new AiOrchestrator(pool),event=(await orchestrator.pending())[0],result=await orchestrator.process(event.conversation_id,event.event_key,reply),store=new AiManagerStore(pool);assert.ok(result.action);
 await pool.query("UPDATE ai_source_runtime_status SET enabled=false WHERE role='max-reader'");assert.equal((await store.preflight(result.action.id)).ready,false);await pool.query("UPDATE ai_source_runtime_status SET enabled=true,heartbeat_at=clock_timestamp() WHERE role='max-reader'");assert.equal((await store.preflight(result.action.id)).ready,true);
});
test('approved source parameters seed qualification with exact source evidence in the same transaction',{skip},async()=>{
 const f=await fixture(),route=await activatedRoute(f);await activateSource(pool,f.scope,route,'automatic');const state=(await pool.query('SELECT fields FROM ai_engine_state WHERE conversation_id=$1',[route.conversationId])).rows[0];assert.deepEqual(state.fields.volume,{value:12,evidenceMessageId:'group-source:-10:source',evidenceQuote:'12 тонн'});
});

test('per-chat replacement can enable auto contact independently and is honored by runtime activation',{skip},async()=>{
 const {ChatCriteriaStore}=await import('./chat-criteria.js'),{SourceRuntime}=await import('./source-runtime.js');const f=await fixture(),policy=await settings.get();await settings.save({expectedRevision:policy.revision,settings:{...policy.settings,autoContact:false}});
 await new ChatCriteriaStore(pool).save({platform:'max',chatId:'-10',expectedRevision:0,mode:'replace',settings:{...policy.settings,autoContact:true,instructions:'Только щебень из этого чата'}});
 const route=await activatedRoute(f);let calls=0;await new SourceRuntime(pool,f.scope,scorer,async()=>{calls++;return route;},new AbortController().signal).tick();assert.equal(calls,1);assert.equal((await pool.query('SELECT status FROM ai_leads WHERE id=$1',[route.leadId])).rows[0].status,'approved');
});
test('changed chat criteria prevent old automatic approval and cancel an unsent first contact',{skip},async()=>{
 const {ChatCriteriaStore}=await import('./chat-criteria.js'),f=await fixture(),route=await activatedRoute(f,f.event,'303',{...demand,params:[]}),chats=new ChatCriteriaStore(pool),policy=await settings.get();
 await chats.save({platform:'max',chatId:'-10',expectedRevision:0,mode:'replace',settings:{...policy.settings,instructions:'Теперь только машины'}});await assert.rejects(activateSource(pool,f.scope,route,'automatic'),/source_requires_review/);
 await chats.save({platform:'max',chatId:'-10',expectedRevision:1,mode:'inherit',settings:policy.settings});await activateSource(pool,f.scope,route,'automatic');
 const o=new AiOrchestrator(pool),event=(await o.pending())[0],result=await o.process(event.conversation_id,event.event_key,reply);assert.ok(result.action);
 await chats.save({platform:'max',chatId:'-10',expectedRevision:2,mode:'replace',settings:{...policy.settings,instructions:'Совсем другие услуги'}});
 let starts=0;await new AiManagerStore(pool).dispatch(result.action.id,{target:{accountId:f.accountId,platform:'max',externalConversationId:route.dialogId},start(){starts++;throw Error('Changed policy must cancel before send');}});assert.equal(starts,0);assert.equal((await pool.query('SELECT state FROM ai_outbox WHERE id=$1',[result.action.id])).rows[0].state,'cancelled');
});

test('manager-confirmed rejection sends its farewell even when source monitoring is paused',{skip},async()=>{
 const f=await fixture(),event={...f.event,text:'Нужно 5 тонн щебня'},assessment={...demand,demandQuote:'Нужно 5 тонн щебня',params:[{key:'volume',value:5,evidenceQuote:'5 тонн'}]},route=await activatedRoute(f,event,'303',assessment);await activateSource(pool,f.scope,route,'automatic');
 const o=new AiOrchestrator(pool),e=(await o.pending())[0],result=await o.process(e.conversation_id,e.event_key,{kind:'fixture',async complete(input){return{replyDraft:'',extracted:[{field:'volume',value:5,evidenceMessageId:input.data.messages.find(m=>m.origin==='customer')!.messageId,evidenceQuote:'5 тонн'}],replyKind:'none',askFields:[],knowledgeKeys:[],proposedStatus:'unqualified',handoffReason:null};}});
 await settings.control({expectedRevision:(await settings.get()).revision,action:'pause'});const {ConversationWorkflow}=await import('./conversation-workflow.js');await new ConversationWorkflow(pool).decideQualification({conversationId:route.conversationId,decisionId:result.decision.id,action:'reject',reason:'Проверил менеджер'});const store=new AiManagerStore(pool),notice=await store.enqueueQualificationNotice(result.decision.id);let starts=0;
 await store.dispatch(notice.id,{target:{accountId:f.accountId,platform:'max',externalConversationId:route.dialogId},start:a=>{starts++;return{acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'confirmed',externalMessageId:'human-approved-farewell',code:'synthetic',retryCondition:'never'})};}});assert.equal(starts,1);assert.equal((await pool.query('SELECT business_status FROM ai_conversations WHERE id=$1',[route.conversationId])).rows[0].business_status,'closed');
});

test('notification-only mode queues matching demand once without contacting the author',{skip},async()=>{
 const {SourceRuntime}=await import('./source-runtime.js');
 const {dispatchSourceNotification}=await import('./source-notification.js');
 const f=await fixture();
 await pool.query("UPDATE ai_engine_settings SET settings=settings||'{\"qualificationEnabled\":false}'::jsonb");
 await pool.query('INSERT INTO ai_manager_target(id,account_id,external_id) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,external_id=excluded.external_id',[f.accountId,'-99']);
 const captured=await f.monitor.capture(f.event);await f.monitor.classify(captured.id!,scorer,new AbortController().signal);
 const n=(await pool.query('SELECT * FROM ai_source_notifications')).rows[0];assert.ok(n);
 let routes=0;await new SourceRuntime(pool,f.scope,scorer,async()=>{routes++;throw Error('must not contact author');},new AbortController().signal).tick();assert.equal(routes,0);
 let sends=0;const socket={connected:true,async send(op:number,body:Record<string,unknown>){if(op===48)return{chats:[{id:-99,type:'CHAT'}]};assert.equal(op,64);assert.equal(body.chatId,-99);assert.match((body.message as {text:string}).text,/Нужно 12 тонн щебня/);sends++;return{message:{id:'receipt'}};}};
 await Promise.all([dispatchSourceNotification(pool,n.id,f.scope,async()=>socket),dispatchSourceNotification(pool,n.id,f.scope,async()=>socket)]);
 assert.equal(sends,1);assert.equal((await pool.query('SELECT state FROM ai_source_notifications WHERE id=$1',[n.id])).rows[0].state,'confirmed');assert.equal((await pool.query('SELECT count(*)::int n FROM ai_outbox')).rows[0].n,0);
});
test('notification-only mode ignores low confidence and retains uncertain delivery without retry',{skip},async()=>{
 const {dispatchSourceNotification}=await import('./source-notification.js');const f=await fixture();
 await pool.query("UPDATE ai_engine_settings SET settings=settings||'{\"qualificationEnabled\":false}'::jsonb");
 await pool.query('INSERT INTO ai_manager_target(id,account_id,external_id) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,external_id=excluded.external_id',[f.accountId,'-99']);
 for(const [i,confidence] of [0.7,0.95].entries()){const c=await f.monitor.capture({...f.event,messageId:String(i)});await f.monitor.classify(c.id!,{async complete(){return {...demand,confidence};}},new AbortController().signal);}
 const rows=(await pool.query('SELECT * FROM ai_source_notifications')).rows;assert.equal(rows.length,1);let sends=0;
 const socket={connected:true,async send(op:number){if(op===48)return{chats:[{id:-99,type:'CHAT'}]};sends++;throw Error('connection lost');}};
 await dispatchSourceNotification(pool,rows[0].id,f.scope,async()=>socket);await dispatchSourceNotification(pool,rows[0].id,f.scope,async()=>socket);
 assert.equal(sends,1);assert.equal((await pool.query('SELECT state FROM ai_source_notifications WHERE id=$1',[rows[0].id])).rows[0].state,'unknown');
});
