import type {Pool,PoolClient} from 'pg';
export type SourceRole='coordinator'|'max-reader'|'whatsapp-reader';
/** Configuration being enabled is not proof that its owning process is running. */
export async function sourceRuntimeReady(db:Pool|PoolClient,platforms:string[]){
 const roles=['coordinator',...new Set(platforms.map(p=>p+'-reader'))];
 const found=(await db.query("SELECT role FROM ai_source_runtime_status WHERE role=ANY($1::text[]) AND enabled AND heartbeat_at>clock_timestamp()-interval '20 seconds'",[roles])).rows;
 return roles.every(role=>found.some(r=>r.role===role));
}
export async function startSourceHeartbeat(pool:Pool,role:SourceRole,enabled:boolean,signal:AbortSignal){
 let closing:Promise<void>|undefined,pending:Promise<void>|undefined;
 const write=async(value:boolean)=>{await pool.query('INSERT INTO ai_source_runtime_status(role,enabled) VALUES($1,$2) ON CONFLICT(role) DO UPDATE SET enabled=excluded.enabled,heartbeat_at=clock_timestamp()',[role,value]);};
 await write(enabled&&!signal.aborted);
 const timer=setInterval(()=>{if(!closing&&!pending)pending=write(enabled&&!signal.aborted).catch(()=>console.error('Source runtime heartbeat deferred')).finally(()=>{pending=undefined;});},5000);timer.unref();
 const close=()=>closing??=(async()=>{clearInterval(timer);await pending;await write(false);signal.removeEventListener('abort',onAbort);})();
 const onAbort=()=>{void close().catch(()=>{});};signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();return{close};
}
