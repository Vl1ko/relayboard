import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {readdir,readFile,lstat,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
/** Plan only by default. Recognizes completed database backups created by local-backup.mjs. */
export async function planBackupRetention(root,{keepCount=7,maxAgeDays=30,now=Date.now()}={}){
 if(!Number.isInteger(keepCount)||keepCount<1||keepCount>1000||!Number.isInteger(maxAgeDays)||maxAgeDays<1||maxAgeDays>3650)throw Error('Invalid backup retention policy');
 const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Backup root must be a real directory');const entries=[];
 for(const name of await readdir(root)){
  if(!/^\d{4}-\d{2}-\d{2}T[0-9-]+Z-[a-f0-9-]{36}$/.test(name))continue;
  const folder=join(root,name),folderInfo=await lstat(folder);if(!folderInfo.isDirectory()||folderInfo.isSymbolicLink())continue;
  const files=(await readdir(folder)).sort();if(files.join('|')!=='database.dump.age|manifest.json')continue;
  const archive=await lstat(join(folder,'database.dump.age')),manifestInfo=await lstat(join(folder,'manifest.json'));if(!archive.isFile()||archive.isSymbolicLink()||!manifestInfo.isFile()||manifestInfo.isSymbolicLink()||manifestInfo.size>10000)continue;
  let m;try{m=JSON.parse(await readFile(join(folder,'manifest.json'),'utf8'));}catch{continue;}
  const created=Date.parse(m.createdAt);if(m.kind!=='database-only'||m.format!=='pg-custom+age'||m.bytes!==archive.size||!/^[a-f0-9]{64}$/.test(m.sha256)||!Number.isFinite(created)||created>now)continue;
  const hash=createHash('sha256');for await(const part of createReadStream(join(folder,'database.dump.age')))hash.update(part);if(hash.digest('hex')!==m.sha256)continue;
  entries.push({name,created,bytes:archive.size});
 }
 entries.sort((a,b)=>b.created-a.created||a.name.localeCompare(b.name));
 // Always preserve the newest recognized complete copy, even if it is old.
 const remove=entries.filter((e,index)=>index>0&&(index>=keepCount||now-e.created>maxAgeDays*86400000));
 return{policy:{keepCount,maxAgeDays},recognized:entries.length,remove:remove.map(({name,bytes})=>({name,bytes})),reclaimableBytes:remove.reduce((n,e)=>n+e.bytes,0),unknownEntriesPreserved:true};
}
export async function pruneBackups(root,options){const plan=await planBackupRetention(root,options);for(const item of plan.remove){const fresh=await planBackupRetention(root,options);if(!fresh.remove.some(r=>r.name===item.name))throw Error('Backup inventory changed; review a new plan');await rm(join(root,item.name),{recursive:true});}return plan;}
async function main(){const root=resolve('data/backups'),options={keepCount:Number(process.env.BACKUP_KEEP_COUNT||7),maxAgeDays:Number(process.env.BACKUP_MAX_AGE_DAYS||30)};const plan=process.argv.includes('--execute')?await pruneBackups(root,options):await planBackupRetention(root,options);console.log(JSON.stringify(plan,null,2));}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Backup retention failed. Unrecognized backups are not removed.');process.exitCode=1;});
