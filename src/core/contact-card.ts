import type {Pool} from 'pg';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {readFile,unlink,readdir,stat} from 'node:fs/promises';
import {basename,resolve,dirname} from 'node:path';
const uuid=z.string().uuid(),body=z.string().trim().min(1).max(8000);
export class CardError extends Error{constructor(public code:string,public status=409){super(code);}}
export class ContactCardStore{
 constructor(private pool:Pool,private root:string){}
 private async tx<T>(fn:(c:import('pg').PoolClient)=>Promise<T>){const c=await this.pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async get(contactId:string){uuid.parse(contactId);if(!(await this.pool.query('SELECT 1 FROM ai_contacts WHERE id=$1',[contactId])).rowCount)throw new CardError('contact_not_found',404);
  const notes=(await this.pool.query('SELECT id,body,revision,created_at,updated_at FROM ai_contact_notes WHERE contact_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 200',[contactId])).rows;
  const files=(await this.pool.query('SELECT id,original_name AS name,size_bytes AS size,created_at FROM ai_contact_files WHERE contact_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 20',[contactId])).rows;return{notes,files};
 }
 async addNote(contactId:string,input:{id:string;body:string}){const d=z.object({id:uuid,body}).strict().parse(input);return this.tx(async c=>{
  if(!(await c.query('SELECT id FROM ai_contacts WHERE id=$1 FOR UPDATE',[uuid.parse(contactId)])).rowCount)throw new CardError('contact_not_found',404);
  const old=(await c.query('SELECT * FROM ai_contact_notes WHERE id=$1',[d.id])).rows[0];if(old){if(old.contact_id!==contactId||old.body!==d.body||old.deleted_at)throw new CardError('card_identity_conflict');return old;}
  if(Number((await c.query('SELECT count(*) n FROM ai_contact_notes WHERE contact_id=$1 AND deleted_at IS NULL',[contactId])).rows[0].n)>=200)throw new CardError('note_limit');
  return(await c.query('INSERT INTO ai_contact_notes(id,contact_id,body) VALUES($1,$2,$3) RETURNING *',[d.id,contactId,d.body])).rows[0];
 });}
 async editNote(contactId:string,id:string,input:{body:string;expectedRevision:number}){const d=z.object({body,expectedRevision:z.number().int().nonnegative()}).strict().parse(input);const r=(await this.pool.query('UPDATE ai_contact_notes SET body=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND contact_id=$2 AND revision=$4 AND deleted_at IS NULL RETURNING id,body,revision',[uuid.parse(id),uuid.parse(contactId),d.body,d.expectedRevision])).rows[0];if(!r)throw new CardError('note_changed');return r;}
 async deleteNote(contactId:string,id:string,expectedRevision:number){z.number().int().nonnegative().parse(expectedRevision);const r=await this.pool.query(`UPDATE ai_contact_notes SET body='[Заметка удалена]',deleted_at=coalesce(deleted_at,now()),revision=revision+CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END WHERE id=$1 AND contact_id=$2 AND (revision=$3 OR deleted_at IS NOT NULL) RETURNING id`,[uuid.parse(id),uuid.parse(contactId),expectedRevision]);if(!r.rowCount)throw new CardError('note_changed');return{deleted:true};}
 private validPath(path:string){if(dirname(resolve(path))!==resolve(this.root))throw new CardError('file_path_invalid');return resolve(path);}
 async addFile(contactId:string,id:string,file:{path:string;originalname:string;size:number}){
  uuid.parse(contactId);uuid.parse(id);this.validPath(file.path);let original=file.originalname;
  if([...original].every(c=>c.charCodeAt(0)<=255)){const decoded=Buffer.from(original,'latin1').toString('utf8');if(!decoded.includes('\ufffd'))original=decoded;}
  const name=basename(original.normalize('NFC').replaceAll('\\','/')).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,200);
  if(!/\.(pdf|docx?|xlsx?|txt|csv|png|jpe?g|webp)$/i.test(name)||file.size<1||file.size>20*1024*1024)throw new CardError('file_type_or_size',400);
  const sha=createHash('sha256').update(await readFile(file.path)).digest('hex');
  return this.tx(async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('contact-card-file-budget',0))");
   if(!(await c.query('SELECT id FROM ai_contacts WHERE id=$1 FOR UPDATE',[contactId])).rowCount)throw new CardError('contact_not_found',404);
   const old=(await c.query('SELECT * FROM ai_contact_files WHERE id=$1',[id])).rows[0];if(old){if(old.contact_id!==contactId||old.sha256!==sha||old.original_name!==name||old.deleted_at)throw new CardError('card_identity_conflict');return{id:old.id,name:old.original_name,size:old.size_bytes};}
   const used=(await c.query('SELECT coalesce(sum(size_bytes),0)::bigint AS total,coalesce(sum(size_bytes) FILTER(WHERE contact_id=$1),0)::bigint AS contact,count(*) FILTER(WHERE contact_id=$1 AND deleted_at IS NULL)::int AS count FROM ai_contact_files WHERE purged_at IS NULL',[contactId])).rows[0];
   if(Number(used.total)+file.size>256*1024*1024||Number(used.contact)+file.size>100*1024*1024||used.count>=20)throw new CardError('file_budget_exceeded',413);
   await c.query('INSERT INTO ai_contact_files(id,contact_id,original_name,storage_path,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6)',[id,contactId,name,file.path,file.size,sha]);return{id,name,size:file.size};
  });
 }
 async download(contactId:string,id:string){const r=(await this.pool.query('SELECT * FROM ai_contact_files WHERE id=$1 AND contact_id=$2 AND deleted_at IS NULL AND purged_at IS NULL',[uuid.parse(id),uuid.parse(contactId)])).rows[0];if(!r)throw new CardError('file_not_found',404);this.validPath(r.storage_path);return r;}
 async deleteFile(contactId:string,id:string){const r=(await this.pool.query('UPDATE ai_contact_files SET deleted_at=coalesce(deleted_at,now()) WHERE id=$1 AND contact_id=$2 RETURNING *',[uuid.parse(id),uuid.parse(contactId)])).rows[0];if(!r)throw new CardError('file_not_found',404);await this.purge(r);return{deleted:true};}
 private async purge(row:any){try{await unlink(this.validPath(row.storage_path));}catch(e){if(!(e&&typeof e==='object'&&'code'in e&&e.code==='ENOENT'))return;}await this.pool.query("UPDATE ai_contact_files SET purged_at=now(),original_name='Удалённый файл' WHERE id=$1 AND deleted_at IS NOT NULL",[row.id]);}
 /** On ambiguous database commits keep the file; cleanup only removes an unreferenced old upload. */
 async cleanupUpload(path:string){try{if(!(await this.pool.query('SELECT 1 FROM ai_contact_files WHERE storage_path=$1',[path])).rowCount)await unlink(this.validPath(path));}catch{ /* Durable cleanup handles unavailable DB/filesystem. */ }}
 async cleanup(){for(const row of(await this.pool.query('SELECT * FROM ai_contact_files WHERE deleted_at IS NOT NULL AND purged_at IS NULL LIMIT 100')).rows)await this.purge(row);
  for(const name of await readdir(this.root)){if(!/^[0-9a-f-]{36}\.upload$/.test(name))continue;const path=resolve(this.root,name),s=await stat(path);if(s.mtimeMs<Date.now()-86400000)await this.cleanupUpload(path);}
 }
}
