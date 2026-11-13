// Run only against an isolated database and queue. All messenger clients are mocked.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
if (!/reliability_test/.test(process.env.DATABASE_URL || '') || !/reliability-test/.test(process.env.QUEUE_NAME || '')) throw new Error('Isolated test database and queue required');
let socketState='OPENING', sends=0, maxConnections=0;
globalThis.window={ require:name=>name==='WAWebSocketModel'?{Socket:{get state(){return socketState}}}:{Chat:{getModelsArray:()=>[]}}, WWebJS:{getChat(){},sendMessage(){}} };
class FakeClient extends EventEmitter {
  pupPage={evaluate:async callback=>callback()};
  async initialize() {}
  async destroy() {}
  async sendMessage(destination) { sends++; if(destination==='slow') await sleep(1800); return {id:{_serialized:`mock-${sends}`}}; }
}
class FakeMax {
  chats={subscribe_all(){},list:[],get:async()=>({messages:{send:async()=>({id:'mock-max'})}})};
  ws={connected:true};
  constructor(token){this.token=token}
  async connect(){maxConnections++; if(this.token==='invalid') throw Object.assign(new Error('Ошибка входа. Пожалуйста, авторизируйтесь снова'),{payload:{error:'login.token'}});}
  on(){} close(){}
}
mock.module('whatsapp-web.js',{defaultExport:{Client:FakeClient,LocalAuth:class{},MessageMedia:class{static fromFilePath(){return {}}}}});
mock.module('@ounezz/umax',{namedExports:{UMax:FakeMax}});
const {pool}=await import('../dist-node/core/db.js');
const {encryptCredentials}=await import('../dist-node/core/crypto.js');
const {publishingQueue}=await import('../dist-node/core/queue.js');
async function account(platform,token='') {
  return (await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES($1,'TEST',$2) RETURNING id,session_key",[platform,encryptCredentials({token})])).rows[0];
}
async function delivery(integration,external='group') {
  const dst=(await pool.query("INSERT INTO destinations(integration_id,external_id,title) VALUES($1,$2,'TEST') ON CONFLICT(integration_id,external_id) DO UPDATE SET title='TEST' RETURNING id",[integration.id,external])).rows[0];
  const post=(await pool.query("INSERT INTO posts(text,mode,status,interval_seconds) VALUES('TEST','now','active',0) RETURNING id")).rows[0];
  return (await pool.query("INSERT INTO deliveries(post_id,destination_id,occurrence_key) VALUES($1,$2,'test') RETURNING *",[post.id,dst.id])).rows[0];
}
async function dispatch(d){await publishingQueue.add('dispatch',{postId:d.post_id,occurrenceKey:d.occurrence_key})}
async function row(id){return(await pool.query('SELECT * FROM deliveries WHERE id=$1',[id])).rows[0]}
async function until(check,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await sleep(80)}throw new Error('Timed out: '+label)}
async function send(d,acc,external='group') {
  const r=await fetch('http://127.0.0.1:3010/send',{method:'POST',headers:{authorization:'Bearer '+process.env.WHATSAPP_BRIDGE_SECRET,'content-type':'application/json','x-account-session':acc.session_key},body:JSON.stringify({deliveryId:d.id,destinationId:external,text:'TEST',attachments:[]})});return{status:r.status,body:await r.json()};
}
try {
  const wa=await account('whatsapp');const max=await account('max','invalid');
  await import('../dist-node/whatsapp-bridge/index.js');
  await import('../dist-node/worker/index.js');
  const waiting=await delivery(wa);await dispatch(waiting);
  await until(async()=> (await row(waiting.id)).last_error_kind==='waiting','waiting state');
  assert.equal((await row(waiting.id)).attempt_count,0);assert.equal(sends,0);
  console.log('PASS: disconnected WhatsApp defers without sending or consuming attempts');
  socketState='CONNECTED';await pool.query('UPDATE deliveries SET next_attempt_at=now() WHERE id=$1',[waiting.id]);await dispatch(waiting);
  await until(async()=>(await row(waiting.id)).status==='sent','recovered send');
  assert.equal(sends,1);assert.equal((await send(waiting,wa)).status,200);assert.equal(sends,1);
  console.log('PASS: reconnection resumes delivery; duplicate request reuses saved receipt');
  const blocked=await delivery(max);await dispatch(blocked);
  await until(async()=>(await pool.query('SELECT auth_error FROM integrations WHERE id=$1',[max.id])).rows[0].auth_error,'MAX token blocked');
  const another=await delivery(max);await dispatch(another);await sleep(300);
  assert.equal(maxConnections,1);assert.equal((await row(blocked.id)).attempt_count,0);assert.equal((await row(another.id)).status,'queued');
  console.log('PASS: invalid MAX token blocks the account after one connection, preserving queued deliveries');
  await pool.query('UPDATE integrations SET credential_ciphertext=$2,auth_error=NULL WHERE id=$1',[max.id,encryptCredentials({token:'valid'})]);
  await pool.query('UPDATE deliveries SET next_attempt_at=now() WHERE id=$1',[blocked.id]);await dispatch(blocked);await dispatch(another);
  await until(async()=>(await row(blocked.id)).status==='sent'&&(await row(another.id)).status==='sent','MAX resumes');
  console.log('PASS: replacing MAX credentials resumes pending deliveries');
  const slow=await delivery(wa,'slow');await dispatch(slow);
  await until(async()=>(await row(slow.id)).status==='unknown','ambiguous timeout');
  assert.equal((await send(slow,wa,'slow')).status,409);
  await until(async()=>(await row(slow.id)).status==='sent','late confirmation');
  assert.equal(sends,2);assert.equal((await send(slow,wa,'slow')).status,200);assert.equal(sends,2);
  console.log('PASS: send timeout is not retried; late confirmation resolves unknown without duplication');
  await publishingQueue.obliterate({force:true});
  console.log('Reliability integration checks passed');process.exit(0);
} catch(error){console.error(error);process.exit(1)}
