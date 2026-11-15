import type {Pool,PoolClient} from 'pg';
import {unlinkStoredAttachment} from './attachment-retention.js';
type Upload={path:string;filename:string;originalname:string;mimetype:string;size:number};
/** A failed DB connection must not leave a whole multipart upload on disk. */
export async function persistUploadedAttachments(pool:Pool,files:Upload[],uploadRoot:string){
 let client:PoolClient|undefined,commitAttempted=false;const saved=[];
 try{
  if(files.some(f=>f.size<1)){const error=new Error('upload_empty_file');throw error;}
  client=await pool.connect();await client.query('BEGIN');
  for(const file of files){const result=await client.query(`INSERT INTO attachments(original_name,stored_name,mime_type,size_bytes,storage_path) VALUES($1,$2,$3,$4,$5) RETURNING id,original_name,mime_type,size_bytes::int`,[file.originalname.slice(0,255),file.filename,file.mimetype||'application/octet-stream',file.size,file.path]);saved.push(result.rows[0]);}
  commitAttempted=true;await client.query('COMMIT');return saved;
 }catch(error){
  await client?.query('ROLLBACK').catch(()=>{});
  // A lost COMMIT response may already have persisted references. Preserve files
  // rather than deleting media belonging to a successfully committed upload.
  if(!commitAttempted)for(const file of files)await unlinkStoredAttachment(uploadRoot,file.path).catch(()=>console.error('Uncommitted upload cleanup deferred'));
  throw error;
 }finally{client?.release();}
}
