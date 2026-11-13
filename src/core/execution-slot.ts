import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";

/** One shared slot across processes; waiting callers never exhaust the DB pool. */
export async function withExecutionSlot<T>(pool: Pool, identity: string, work: (signal: AbortSignal) => Promise<T>, signal = AbortSignal.timeout(300_000)): Promise<T> {
  const key = createHash('sha256').update(identity).digest().readBigInt64BE().toString();
  for (;;) {
    signal.throwIfAborted();
    const client = await pool.connect();
    let locked = false;
    let broken = false;
    const owner = new AbortController();
    const lost = () => { broken = true; owner.abort(new Error('execution_slot_lost')); };
    client.on('error', lost);
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key])).rows[0].acquired;
      if (locked) {
        let heartbeat:Promise<void>|undefined;
        const timer=setInterval(()=>{
          if(!heartbeat&&!owner.signal.aborted){
            const probe={text:'SELECT 1',query_timeout:5000};
            heartbeat=client.query(probe).then(()=>{},()=>lost()).finally(()=>{heartbeat=undefined;});
          }
        },10000);timer.unref();
        try{
          const result = await work(AbortSignal.any([signal, owner.signal]));
          owner.signal.throwIfAborted();
          return result;
        }finally{clearInterval(timer);await heartbeat;}
      }
    } finally {
      if (locked && !broken) {
        try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]); }
        catch { broken = true; }
      }
      client.removeListener('error', lost);
      client.release(broken);
    }
    await delay(100, undefined, { signal });
  }
}
