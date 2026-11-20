import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import type {Pool} from 'pg';import {persistUploadedAttachments} from './uploaded-attachments.js';
test('DB connection or insert failure removes only new multipart files; ambiguous commit preserves them',async()=>{
 for(const failure of ['connect','insert','commit']){
  const root=await mkdtemp(join(tmpdir(),'relayboard-upload-failure-')),path=join(root,'new.txt'),keep=join(root,'existing.txt');await writeFile(path,'new');await writeFile(keep,'existing');let released=false;
  const pool={async connect(){if(failure==='connect')throw Error('Synthetic unavailable DB');return{async query(sql:string){if(sql==='COMMIT'&&failure==='commit'||sql.startsWith('INSERT')&&failure==='insert')throw Error('Synthetic DB failure');return{rows:[{id:'synthetic'}]};},release(){released=true;}};}} as unknown as Pool;
  try{await assert.rejects(persistUploadedAttachments(pool,[{path,filename:'new.txt',originalname:'new.txt',mimetype:'text/plain',size:3}],root));assert.equal(await readFile(keep,'utf8'),'existing');if(failure==='commit')assert.equal(await readFile(path,'utf8'),'new');else await assert.rejects(readFile(path),{code:'ENOENT'});assert.equal(released,failure!=='connect');}finally{await rm(root,{recursive:true,force:true});}
 }
});
