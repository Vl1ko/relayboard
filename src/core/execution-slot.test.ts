import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {before,after,test} from 'node:test';
import pg from 'pg';
import {withExecutionSlot} from './execution-slot.js';
const url=process.env.AI_MANAGER_TEST_DATABASE_URL,skip=!url;
let pool:pg.Pool;
before(()=>{if(url){if(!new URL(url).pathname.endsWith('/relayboard_ai_manager_test'))throw Error('Dedicated test database required');pool=new pg.Pool({connectionString:url,max:2});}});
after(async()=>{await pool?.end();});
test('twenty independent callers serialize one credential without exhausting a two-connection pool',{skip},async()=>{
 const key=randomUUID();let active=0,max=0;
 const rows=await Promise.all(Array.from({length:20},(_,i)=>withExecutionSlot(pool,key,async()=>{
  active++;max=Math.max(max,active);await pool.query('SELECT 1');await delay(2);active--;return i;
 })));
 assert.equal(max,1);assert.equal(rows.length,20);assert.equal(active,0);
});
test('waiting abort does not cancel the owner; failed owner releases the slot',{skip},async()=>{
 const key=randomUUID(),abort=new AbortController();let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 const owner=withExecutionSlot(pool,key,async()=>{enter();await gate;return 'owner';});await entered;
 const waiter=withExecutionSlot(pool,key,async()=>{throw Error('must not start');},abort.signal);
 const rejected=assert.rejects(waiter,/abort/i);abort.abort();await rejected;release();assert.equal(await owner,'owner');
 await assert.rejects(withExecutionSlot(pool,key,async()=>{throw Error('work failed');}),/work failed/);
 assert.equal(await withExecutionSlot(pool,key,async()=>42),42);
});
test('different credentials execute independently',{skip},async()=>{
 let count=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const work=async()=>{if(++count===2)release();await gate;return true;};
 assert.deepEqual(await Promise.all([withExecutionSlot(pool,randomUUID(),work),withExecutionSlot(pool,randomUUID(),work)]),[true,true]);
});
test('lost database ownership aborts work and never reports successful completion',{skip},async()=>{
 const key=randomUUID(),mark=randomUUID();const hash=createHash('sha256').update(key).digest();const lockParts=[hash.readUInt32BE(0),hash.readUInt32BE(4)];let enter!:()=>void;const entered=new Promise<void>(r=>enter=r);
 const owner=withExecutionSlot(pool,key,async signal=>{
  const rows=await pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND granted",lockParts);
  assert.ok(rows.rowCount);enter();await delay(10000,undefined,{signal});return 'unreachable';
 });
 const rejected=assert.rejects(owner,/abort|slot_lost/i);await entered;
 // The other session of this dedicated pool identifies only its own active advisory owner.
 await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND pid IN (SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND granted)",lockParts);
 await rejected;assert.equal(await withExecutionSlot(pool,key,async()=>mark),mark);
});
