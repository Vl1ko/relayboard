/** Limit work per iteration, never the number of monitored chats. Errors do not pin the queue. */
export class SourceReadBatch {
 private after:string|undefined;
 take<T extends {account_id:string;chat_id:string}>(sources:T[],size=5):T[]{
  if(!Number.isSafeInteger(size)||size<1)throw Error('invalid_source_batch_size');
  const key=(s:T)=>JSON.stringify([s.account_id,s.chat_id]);
  const rows=[...sources].sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);
  if(!rows.length){this.after=undefined;return[];}
  const next=this.after===undefined?0:rows.findIndex(r=>key(r)>this.after!);
  const start=next<0?0:next,result=Array.from({length:Math.min(size,rows.length)},(_,i)=>rows[(start+i)%rows.length]);
  this.after=key(result.at(-1)!);return result;
 }
}
