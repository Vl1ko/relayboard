import {createProtocolRouter} from './protocol-router.js';
import {bindSourceRequest} from '../core/request-lifecycle.js';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import pg from "pg";
import { applyAiManagerMigration } from "../core/ai-manager-migration.js";
import { ConversationWorkflow } from "../core/conversation-workflow.js";
import { createConversationRouter } from "./conversation-router.js";
const url = process.env.WORKSPACE_TEST_DATABASE_URL,
  skip = !url;
let pool: pg.Pool, schema: string, server: Server, base: string;
const manualScope={testOnly:true,accountIds:[] as string[],authorIds:[] as string[]};
const headers = {
  "x-synthetic-admin": "yes",
  "content-type": "application/json",
};
before(async () => {
  if (!url) return;
  if (new URL(url).pathname !== "/relayboard_workspace_test")
    throw new Error("Dedicated relayboard_workspace_test required");
  schema = "workspace_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("CREATE SCHEMA " + schema);
  await admin.end();
  pool = new pg.Pool({
    connectionString: url,
    options: "-c search_path=" + schema + ",public",
  });
  await pool.query(
    await readFile(
      new URL("../../database/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  await applyAiManagerMigration(pool);
  const app = express();
  app.use(express.json());
  const authorize: import("express").RequestHandler = (req, res, next) =>
    req.header("x-synthetic-admin") === "yes" ? next() : res.sendStatus(401);
  app.use(
    "/on",
    createConversationRouter({
      pool,
      authorize,
      enabled: true,
      workflow: new ConversationWorkflow(pool,{requireRequestContext:true}),
    }),
  );
  app.use('/protocol-live',createProtocolRouter({pool,authorize,enabled:true,syntheticEnabled:false,liveManualScope:manualScope}));
  app.use('/protocol-disabled',createProtocolRouter({pool,authorize,enabled:true,syntheticEnabled:false}));
  app.use(
    "/off",
    createConversationRouter({ pool, authorize, enabled: false }),
  );
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = "http://127.0.0.1:" + address.port;
});
beforeEach(async () => {
  manualScope.accountIds=[];manualScope.authorIds=[];
  if (pool) await pool.query("TRUNCATE ai_contacts,integrations CASCADE");
});
after(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (pool) {
    await pool.query("DROP SCHEMA " + schema + " CASCADE");
    await pool.end();
  }
});
async function fixture() {
  const contact = (
    await pool.query(
      "INSERT INTO ai_contacts(display_name,phone_e164) VALUES('Synthetic Alice','+12025550101') RETURNING id",
    )
  ).rows[0].id;
  const other = (
    await pool.query(
      "INSERT INTO ai_contacts(display_name,phone_e164) VALUES('Synthetic Bob','+12025550102') RETURNING id",
    )
  ).rows[0].id;
  const max = (
    await pool.query(
      "INSERT INTO integrations(platform,name,credential_ciphertext,auth_error) VALUES('max','Team MAX','secret-cipher','secret-auth-detail') RETURNING id",
    )
  ).rows[0].id;
  const wa = (
    await pool.query(
      "INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('whatsapp','Team WhatsApp','another-secret') RETURNING id",
    )
  ).rows[0].id;
  const conv = (
    await pool.query(
      "INSERT INTO ai_conversations(contact_id,account_id,platform,external_id,automation_mode) VALUES($1,$2,'max','max-dialog','auto') RETURNING id",
      [contact, max],
    )
  ).rows[0].id;
  const second = (
    await pool.query(
      "INSERT INTO ai_conversations(contact_id,account_id,platform,external_id,business_status,automation_mode) VALUES($1,$2,'whatsapp','wa-dialog','manager_required','manual') RETURNING id",
      [contact, wa],
    )
  ).rows[0].id;
  const bob = (
    await pool.query(
      "INSERT INTO ai_conversations(contact_id,account_id,platform,external_id,business_status) VALUES($1,$2,'max','bob-dialog','closed') RETURNING id",
      [other, max],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO ai_inbox(event_key,conversation_id,external_message_id,occurred_at,direction,origin,disposition,text) VALUES('a',$1,'message-a','2026-11-13T10:00:00Z','inbound','customer','process_customer','literal %_ search'),('b',$2,'message-b','2026-11-13T10:01:00Z','outbound','human','takeover','human history'),('c',$3,'message-c','2026-11-13T10:02:00Z','inbound','customer','process_customer','Bob only')",
    [conv, second, bob],
  );
  return { contact, other, max, wa, conv, second, bob };
}
async function get(path: string) {
  return fetch(base + "/on" + path, { headers });
}
test(
  "workspace authorizes before access and disabled module remains inaccessible",
  { skip },
  async () => {
    assert.equal((await fetch(base + "/on/contacts")).status, 401);
    assert.equal(
      (await fetch(base + "/off/contacts", { headers })).status,
      503,
    );
  },
);
test(
  "list groups two channels into one contact and never exposes credential or auth details",
  { skip },
  async () => {
    const f = await fixture(),
      response = await get("/contacts?sort=name");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = await response.json();
    assert.equal(data.total, 2);
    assert.equal(data.contacts.length, 2);
    assert.equal(data.contacts[0].id, f.contact);
    assert.equal(data.contacts[0].conversations.length, 2);
    assert.equal(data.counters.new, 1);
    assert.equal(data.counters.closed, 1);
    assert.equal(data.counters.review, 1);
    assert.equal(data.counterRule, "contact-presence-v1");
    assert.ok(!JSON.stringify(data).includes("secret"));
  },
);
test(
  "search escapes SQL wildcards; channel and status filters must match the same conversation",
  { skip },
  async () => {
    await fixture();
    const literal = await (
      await get("/contacts?q=" + encodeURIComponent("%_"))
    ).json();
    assert.equal(literal.total, 1);
    const impossible = await (
      await get("/contacts?platform=max&mode=manual")
    ).json();
    assert.equal(impossible.total, 0);
    const matching = await (
      await get("/contacts?platform=whatsapp&status=manager_required")
    ).json();
    assert.equal(matching.total, 1);
    assert.equal((await get("/contacts?sort=sql-injection")).status, 400);
    assert.equal((await get("/contacts?limit=100000")).status, 400);
  },
);
test(
  "detail keeps histories attached to account/conversation and supports older pages",
  { skip },
  async () => {
    const f = await fixture();
    const response = await get("/contacts/" + f.contact + "?limit=1");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.messageTotal, 2);
    assert.equal(data.messages.length, 1);
    assert.equal(data.messages[0].conversationId, f.second);
    const older = await (
      await get("/contacts/" + f.contact + "?limit=1&offset=1")
    ).json();
    assert.equal(older.messages[0].conversationId, f.conv);
    const channel = await (
      await get("/contacts/" + f.contact + "?conversationId=" + f.conv)
    ).json();
    assert.equal(channel.messageTotal, 1);
    assert.equal(channel.messages[0].conversationId, f.conv);
    assert.equal(
      (await get("/contacts/" + f.contact + "?conversationId=" + f.bob)).status,
      404,
    );
    assert.ok(!JSON.stringify(data).includes("Bob only"));
    assert.equal((await get("/contacts/" + randomUUID())).status, 404);
  },
);
test(
  "takeover is contact-wide, preserves unknown outcomes and prevents browser qualification forgery",
  { skip },
  async () => {
    const f = await fixture();
    await pool.query(
      "INSERT INTO ai_outbox(contact_id,conversation_id,logical_key,kind,text,fingerprint,automation_epoch,state) VALUES($1,$2,'pending','reply','pending text','p',0,'pending'),($1,$3,'unknown','reply','unknown text','u',0,'unknown')",
      [f.contact, f.conv, f.second],
    );
    let r = await fetch(base + "/on/conversations/" + f.conv + "/mode", {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "manual" }),
    });
    assert.equal(r.status, 200);
    const rows = (
      await pool.query(
        "SELECT automation_mode FROM ai_conversations WHERE contact_id=$1",
        [f.contact],
      )
    ).rows;
    assert.ok(rows.every((r) => r.automation_mode === "manual"));
    const states = (
      await pool.query("SELECT state FROM ai_outbox ORDER BY logical_key")
    ).rows.map((r) => r.state);
    assert.deepEqual(states, ["cancelled", "unknown"]);
    r = await fetch(base + "/on/conversations/" + f.conv + "/status", {
      method: "POST",
      headers,
      body: JSON.stringify({
        status: "qualified",
        reason: "browser says so",
        proof: { verified: true },
      }),
    });
    assert.equal(r.status, 400);
    assert.equal(
      (
        await pool.query(
          "SELECT business_status FROM ai_conversations WHERE id=$1",
          [f.conv],
        )
      ).rows[0].business_status,
      "manager_working",
    );
  },
);
test(
  "opt-out persists on contact and explicit resume cannot bypass it",
  { skip },
  async () => {
    const f = await fixture();
    const r = await fetch(base + "/on/contacts/" + f.contact + "/opt-out", {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "synthetic explicit stop" }),
    });
    assert.equal(r.status, 200);
    assert.equal(
      (await (await get("/contacts/" + f.contact)).json()).contact.optedOut,
      true,
    );
    assert.equal(
      (
        await fetch(base + "/on/conversations/" + f.conv + "/mode", {
          method: "POST",
          headers,
          body: '{"mode":"auto"}',
        })
      ).status,
      409,
    );
  },
);
test(
  "manager target and followup rules are explicit settings, never delivery acknowledgements",
  { skip },
  async () => {
    const f = await fixture();
    let r = await fetch(base + "/on/settings/manager", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        accountId: f.max,
        externalId: "synthetic-manager",
      }),
    });
    assert.equal(r.status, 200);
    const rule = {
      scenario: "no_reply",
      enabled: false,
      timezone: "Europe/Moscow",
      weekdays: [1, 2, 3, 4, 5],
      startMinute: 540,
      endMinute: 1080,
      maxSends: 1,
      steps: [{ delaySeconds: 60, text: "synthetic followup" }],
    };
    r = await fetch(base + "/on/settings/followups", {
      method: "PUT",
      headers,
      body: JSON.stringify(rule),
    });
    assert.equal(r.status, 200);
    const settings = await (await get("/settings")).json();
    assert.equal(settings.managerTarget.accountId, f.max);
    assert.equal(settings.followupRules.length, 1);
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM ai_outbox")).rows[0].n,
      0,
    );
    assert.equal(
      (
        await fetch(base + "/on/notifications/outcome", {
          method: "POST",
          headers,
          body: '{"outcome":"confirmed"}',
        })
      ).status,
      404,
    );
  },
);

test('business stage API preserves configured names, revisions and exact operation replay',{skip},async()=>{
 await pool.query('UPDATE ai_engine_settings SET settings=settings||$1::jsonb',[JSON.stringify({qualificationEnabled:true,fields:[{key:"volume",question:"Объём?",required:true}],rules:[{field:"volume",op:"gte",value:10}]})]);
 const f=await fixture();const v=(await pool.query("SELECT * FROM ai_conversations WHERE contact_id=$1 AND platform='max'",[f.contact])).rows[0];
 const binding=await bindSourceRequest(pool,{conversationId:v.id,accountId:f.max,platform:'max',chatId:'synthetic-group',messageId:'stage-source',authorId:'synthetic-author'});
 const epoch=(await pool.query('SELECT automation_epoch FROM ai_conversations WHERE id=$1',[v.id])).rows[0].automation_epoch;
 const input={operationId:randomUUID(),expectedRevision:0,expectedRequestId:binding.requestId,expectedEpoch:epoch,kind:'booking_offered',note:'Synthetic stage mark'};
 const response=await fetch(base+'/on/conversations/'+v.id+'/business-events',{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,200);assert.equal((await response.json()).state.booking_state,'offered');
 const replay=await fetch(base+'/on/conversations/'+v.id+'/business-events',{method:'POST',headers,body:JSON.stringify(input)});assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
 const stale=await fetch(base+'/on/conversations/'+v.id+'/business-events',{method:'POST',headers,body:JSON.stringify({...input,operationId:randomUUID()})});assert.equal(stale.status,409);
 const detail=await(await get('/conversations/'+v.id+'/workflow')).json();assert.equal(detail.business.state.revision,1);assert.equal(detail.business.events.length,1);
});
test('storage policy is authenticated, bounded and revision-controlled',{skip},async()=>{
 assert.equal((await fetch(base+'/on/settings/storage')).status,401);
 const settings=await(await get('/settings/storage')).json();assert.equal(settings.dialogueDays,30);
 const save=await fetch(base+'/on/settings/storage',{method:'PUT',headers,body:JSON.stringify({expectedRevision:settings.revision,dialogueDays:45})});assert.equal(save.status,200);assert.equal((await save.json()).dialogueDays,45);
 assert.equal((await fetch(base+'/on/settings/storage',{method:'PUT',headers,body:JSON.stringify({expectedRevision:settings.revision,dialogueDays:1})})).status,409);
 assert.equal((await fetch(base+'/on/settings/storage',{method:'PUT',headers,body:JSON.stringify({expectedRevision:settings.revision+1,dialogueDays:0})})).status,400);
});

test('priority filtering/sorting and concurrent card revision never change automation',{skip},async()=>{
 const f=await fixture();const path=base+'/on/contacts/'+f.contact+'/priority';
 const responses=await Promise.all(Array.from({length:20},()=>fetch(path,{method:'POST',headers,body:JSON.stringify({priority:'high',expectedRevision:0})})));
 assert.equal(responses.filter(r=>r.status===200).length,1);assert.equal(responses.filter(r=>r.status===409).length,19);
 const high=await(await get('/contacts?priority=high')).json();assert.equal(high.total,1);assert.equal(high.contacts[0].id,f.contact);assert.equal(high.contacts[0].priorityRevision,1);
 const sorted=await(await get('/contacts?sort=priority')).json();assert.equal(sorted.contacts[0].id,f.contact);
 assert.equal((await fetch(path,{method:'POST',headers,body:JSON.stringify({priority:'urgent',expectedRevision:1})})).status,400);
 assert.equal((await pool.query('SELECT count(*)::int n FROM ai_outbox')).rows[0].n,0);assert.equal((await pool.query('SELECT automation_mode FROM ai_conversations WHERE id=$1',[f.conv])).rows[0].automation_mode,'auto');
});
test('live manual API requires verified active route and test scope; concurrent replay creates one held-manager action',{skip},async()=>{
 const f=await fixture();await pool.query('UPDATE ai_engine_settings SET settings=settings||$1::jsonb',[JSON.stringify({qualificationEnabled:true,fields:[{key:'volume',question:'Объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);
 await bindSourceRequest(pool,{conversationId:f.conv,accountId:f.max,platform:'max',chatId:'-10',messageId:'manual-source',authorId:'200'});
 const ctx=(await pool.query('SELECT v.automation_epoch,p.request_id FROM ai_conversations v JOIN ai_request_phases p ON p.id=v.active_phase_id WHERE v.id=$1',[f.conv])).rows[0];
 const path='/conversations/'+f.conv,body={operationId:randomUUID(),text:'Synthetic manager answer',expectedRequestId:ctx.request_id,expectedEpoch:ctx.automation_epoch};
 assert.equal((await fetch(base+'/protocol-live'+path+'/manual-capabilities')).status,401);
 assert.equal((await fetch(base+'/protocol-disabled'+path+'/manual-messages',{method:'POST',headers,body:JSON.stringify(body)})).status,503);
 assert.equal((await fetch(base+'/protocol-live'+path+'/manual-messages',{method:'POST',headers,body:JSON.stringify(body)})).status,409);
 manualScope.accountIds=[f.max];manualScope.authorIds=['200'];await pool.query('UPDATE integrations SET auth_error=NULL WHERE id=$1',[f.max]);
 await pool.query("INSERT INTO ai_verified_routes(conversation_id,account_id,platform,external_id,recipient_id,contact_id) VALUES($1,$2,'max','max-dialog','200',$3)",[f.conv,f.max,f.contact]);
 const capabilities=await(await fetch(base+'/protocol-live'+path+'/manual-capabilities',{headers})).json();assert.equal(capabilities.mode,'live');assert.equal(capabilities.canStart,true);
 await pool.query("UPDATE ai_conversations SET manager_hold=true,automation_mode='paused',business_status='qualified' WHERE id=$1",[f.conv]);
 const rows=await Promise.all(Array.from({length:20},async()=>{const r=await fetch(base+'/protocol-live'+path+'/manual-messages',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();}));assert.equal(new Set(rows.map(r=>r.action.id)).size,1);
 const v=(await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[f.conv])).rows[0];assert.equal(v.automation_mode,'manual');assert.equal(v.manager_hold,true);
 manualScope.authorIds=[];assert.equal((await(await fetch(base+'/protocol-live'+path+'/manual-capabilities',{headers})).json()).canStart,false);
 assert.equal((await fetch(base+'/protocol-live'+path+'/manual-messages',{method:'POST',headers,body:JSON.stringify({...body,operationId:randomUUID()})})).status,409);
 assert.equal((await pool.query('SELECT count(*)::int n FROM ai_outbox')).rows[0].n,1);
 assert.equal((await fetch(base+'/protocol-live/events',{method:'POST',headers,body:'{}'})).status,503);
});
test('request history separates archived/new phases and rejects cross-contact or unrelated-channel scopes',{skip},async()=>{
 const f=await fixture();await pool.query('UPDATE ai_engine_settings SET settings=settings||$1::jsonb',[JSON.stringify({qualificationEnabled:true,fields:[{key:'volume',question:'Объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);
 await pool.query("INSERT INTO destinations(integration_id,external_id,title,kind) VALUES($1,'-10','Тестовая','group')",[f.max]);
 const old=await bindSourceRequest(pool,{conversationId:f.conv,accountId:f.max,platform:'max',chatId:'-10',messageId:'request-old-source',authorId:'200'});
 const {AiManagerStore}=await import('../core/ai-manager.js'),store=new AiManagerStore(pool);await store.ingest({version:1,platform:'max',accountId:f.max,conversationId:'max-dialog',messageId:'group-source:-10:request-old-source',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'Old request: 5 tonnes'});
 await pool.query('UPDATE ai_engine_state SET fields=$2 WHERE conversation_id=$1',[f.conv,{volume:{value:5,evidenceQuote:'5 tonnes'}}]);const v=(await pool.query('SELECT automation_epoch FROM ai_conversations WHERE id=$1',[f.conv])).rows[0];
 await store.enqueue({conversationId:f.conv,kind:'reply',expectedEpoch:v.automation_epoch,logicalKey:'old-request-reply',text:'Old request answer'});await new ConversationWorkflow(pool).setStatus({conversationId:f.conv,status:'closed',reason:'Synthetic manager closure'});
 const next=await bindSourceRequest(pool,{conversationId:f.conv,accountId:f.max,platform:'max',chatId:'-10',messageId:'request-new-source',authorId:'200'});await store.ingest({version:1,platform:'max',accountId:f.max,conversationId:'max-dialog',messageId:'new-private-input',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'New request: 25 tonnes'});
 const list=await(await get('/contacts/'+f.contact+'/requests')).json();assert.equal(list.requests.length,2);assert.equal(list.requests[0].id,next.requestId);
 const archived=await(await get('/contacts/'+f.contact+'/requests/'+old.requestId)).json();assert.equal(archived.request.lifecycle,'closed');assert.equal(archived.sources[0].chatTitle,'Тестовая');assert.equal(archived.phases[0].fields.volume.value,5);
 const history=await(await get('/contacts/'+f.contact+'?conversationId='+f.conv+'&requestId='+old.requestId)).json();assert.equal(history.requestId,old.requestId);assert.equal(history.messages.length,1);assert.match(history.messages[0].text,/Old request/);assert.equal(history.actions.length,1);assert.equal(history.contact.conversations.find((c:any)=>c.id===f.conv).requestId,next.requestId);
 const foreign=randomUUID();await pool.query('INSERT INTO ai_requests(id,contact_id) VALUES($1,$2)',[foreign,f.other]);assert.equal((await get('/contacts/'+f.contact+'/requests/'+foreign)).status,404);assert.equal((await get('/contacts/'+f.contact+'?requestId='+foreign)).status,404);assert.equal((await get('/contacts/'+f.contact+'?conversationId='+f.second+'&requestId='+old.requestId)).status,404);
 assert.equal((await fetch(base+'/on/contacts/'+f.contact+'/requests')).status,401);
});

test('stale manager tab cannot mutate or message a replacement request; accepted manual replay stays stable',{skip},async()=>{
 const f=await fixture();await pool.query('UPDATE ai_engine_settings SET settings=settings||$1::jsonb',[JSON.stringify({qualificationEnabled:true,fields:[{key:'volume',question:'Объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);
 const old=await bindSourceRequest(pool,{conversationId:f.conv,accountId:f.max,platform:'max',chatId:'-10',messageId:'stale-old',authorId:'200'});
 const before=(await pool.query('SELECT automation_epoch FROM ai_conversations WHERE id=$1',[f.conv])).rows[0];
 const context={expectedRequestId:old.requestId,expectedEpoch:before.automation_epoch};
 manualScope.accountIds=[f.max];manualScope.authorIds=['200'];await pool.query('UPDATE integrations SET auth_error=NULL WHERE id=$1',[f.max]);
 await pool.query("INSERT INTO ai_verified_routes(conversation_id,account_id,platform,external_id,recipient_id,contact_id) VALUES($1,$2,'max','max-dialog','200',$3)",[f.conv,f.max,f.contact]);
 const manual={...context,operationId:randomUUID(),text:'Original request manual answer'};
 const post=async(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
 const receipt=await post('/protocol-live/conversations/'+f.conv+'/manual-messages',manual);assert.equal(receipt.status,200);const action=(await receipt.json()).action;
 await new ConversationWorkflow(pool).setStatus({conversationId:f.conv,status:'closed',reason:'Finish old test request'});
 const next=await bindSourceRequest(pool,{conversationId:f.conv,accountId:f.max,platform:'max',chatId:'-10',messageId:'stale-new',authorId:'200'});assert.notEqual(next.requestId,old.requestId);
 const snapshot=(await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[f.conv])).rows[0];
 const commands:[string,unknown][]=[['mode',{mode:'manual'}],['status',{status:'closed',reason:'Old card'}],['followups',{scenario:'no_reply',key:randomUUID(),anchorAt:new Date().toISOString()}],['cancel-followups',{reason:'closed'}],['handoff',{key:randomUUID(),reason:'human_requested',summary:'Old card handoff'}],['business-events',{operationId:randomUUID(),expectedRevision:0,kind:'booking_offered'}]];
 for(const [suffix,body] of commands){const response=await post('/on/conversations/'+f.conv+'/'+suffix,{...body as object,...context});assert.equal(response.status,409,suffix+': '+await response.text());}
 for(const ctx of [context,{}]){const response=await post('/protocol-live/conversations/'+f.conv+'/manual-messages',{...manual,...ctx,expectedRequestId:'expectedRequestId' in ctx?ctx.expectedRequestId:undefined,expectedEpoch:'expectedEpoch' in ctx?ctx.expectedEpoch:undefined,operationId:randomUUID()});assert.equal(response.status,409);}
 const missing=await post('/on/conversations/'+f.conv+'/mode',{mode:'manual'});assert.equal(missing.status,409);
 assert.deepEqual((await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[f.conv])).rows[0],snapshot);
 assert.equal((await pool.query('SELECT count(*)::int n FROM ai_business_events')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_handoff_notifications')).rows[0].n,0);
 const replay=await post('/protocol-live/conversations/'+f.conv+'/manual-messages',manual);assert.equal(replay.status,200);assert.equal((await replay.json()).action.id,action.id);
 assert.equal((await pool.query("SELECT count(*)::int n FROM ai_outbox WHERE kind='manual_reply'")).rows[0].n,1);
 const current={expectedRequestId:next.requestId,expectedEpoch:snapshot.automation_epoch};const valid=await post('/on/conversations/'+f.conv+'/mode',{...current,mode:'manual'});assert.equal(valid.status,200,await valid.text());
});
