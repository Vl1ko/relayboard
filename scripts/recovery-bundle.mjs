import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {open,lstat,readdir,mkdir,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {encryptBackupStream,agePath} from './local-backup.mjs';
const magic=Buffer.from('RELAYBOARD-RECOVERY-1\n'),maxManifest=8*1024**2;
function safeName(name){return typeof name==='string'&&name.length<=1024&&/^(database|config|uploads|profiles|queues)\//.test(name)&&!name.includes('\\')&&!name.includes('\0')&&name.split('/').every(v=>v&&v!=='.'&&v!=='..');}
async function digest(path){const hash=createHash('sha256');for await(const part of createReadStream(path))hash.update(part);return hash.digest('hex');}
async function inventory(root,prefix,result){const info=await lstat(root);if(info.isSymbolicLink())throw Error('Recovery snapshots must not contain symbolic links');if(info.isDirectory()){for(const name of (await readdir(root)).sort())await inventory(join(root,name),prefix+'/'+name,result);return;}if(!info.isFile()||!safeName(prefix))throw Error('Unsupported recovery file');result.push({path:root,name:prefix,size:info.size,sha256:await digest(root),mtime:info.mtimeMs});if(result.length>50000)throw Error('Recovery file count exceeded');}
/** Packs already-quiesced snapshots. Never copies live Chromium profiles or stops production. */
export async function createRecoveryBundle(spec,output,recipient,{maxBytes=4*1024**3}={}){
 if(spec.version!==1||spec.quiesced!==true||!/^([a-f0-9]{7,40}|synthetic)$/.test(spec.releaseCommit||'')||!Number.isFinite(Date.parse(spec.capturedAt)))throw Error('Quiesced snapshot metadata required');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1024)throw Error('Invalid recovery budget');
 const rows=[];
 for(const [key,name] of [['databaseFile','database/database.dump'],['configFile','config/application.env'],['queueFile','queues/redis.snapshot']]){if(typeof spec[key]!=='string'||!(await lstat(spec[key])).isFile())throw Error('Required recovery file missing');await inventory(resolve(spec[key]),name,rows);}
 for(const [key,name] of [['uploadsDir','uploads'],['profilesDir','profiles']]){if(typeof spec[key]!=='string'||!(await lstat(spec[key])).isDirectory())throw Error('Required recovery directory missing');await inventory(resolve(spec[key]),name,rows);}
 const cfgInfo=await lstat(spec.configFile);if((cfgInfo.mode&0o077)!==0)throw Error('Recovery configuration must be private');
 const cfg=await readFile(spec.configFile,'utf8');if(!/^APP_ENCRYPTION_KEY=.+/m.test(cfg))throw Error('Application encryption key missing from recovery configuration');
 const total=rows.reduce((n,r)=>n+r.size,0);if(total>maxBytes)throw Error('Recovery size budget exceeded');
 const manifest={format:1,releaseCommit:spec.releaseCommit,capturedAt:spec.capturedAt,quiesced:true,completeForDisasterRecovery:true,roles:['database','config','uploads','profiles','queues'],files:rows.map(({name,size,sha256})=>({name,size,sha256}))};
 const json=Buffer.from(JSON.stringify(manifest));if(json.length>maxManifest)throw Error('Recovery manifest too large');const length=Buffer.alloc(4);length.writeUInt32BE(json.length);
 async function* source(){yield magic;yield length;yield json;for(const row of rows){const now=await lstat(row.path);if(!now.isFile()||now.isSymbolicLink()||now.size!==row.size||now.mtimeMs!==row.mtime)throw Error('Recovery source changed');const hash=createHash('sha256');for await(const part of createReadStream(row.path)){hash.update(part);yield part;}if(hash.digest('hex')!==row.sha256)throw Error('Recovery source changed');}}
 return{...await encryptBackupStream(Readable.from(source()),output,recipient,{maxBytes:maxBytes+maxManifest+1024}),files:rows.length,plaintextBytes:total,completeForDisasterRecovery:true};
}
class Cursor{
 constructor(stream){this.parts=stream[Symbol.asyncIterator]();this.pending=Buffer.alloc(0);}
 async take(limit){if(!this.pending.length){const next=await this.parts.next();if(next.done)return Buffer.alloc(0);this.pending=next.value;}const result=this.pending.subarray(0,limit);this.pending=this.pending.subarray(result.length);return result;}
 async exact(size){const result=Buffer.alloc(size);let at=0;while(at<size){const chunk=await this.take(size-at);if(!chunk.length)throw Error('Truncated recovery bundle');chunk.copy(result,at);at+=chunk.length;}return result;}
}
/** Restores only into a new private directory; no service starts or messages are sent. */
export async function restoreRecoveryBundle(archive,identity,destination,{maxBytes=4*1024**3}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1024)throw Error('Invalid recovery budget');
 const key=await lstat(identity);if(!key.isFile()||key.isSymbolicLink()||(key.mode&0o077)!==0)throw Error('Private identity required');
 await mkdir(destination,{mode:0o700});await chmod(destination,0o700);let child,done;
 try{
  child=spawn(agePath,['--decrypt','--identity',identity,archive],{stdio:['ignore','pipe','ignore']});
  done=new Promise((yes,no)=>{child.once('error',()=>no(Error('Recovery decrypt failed')));child.once('exit',code=>code===0?yes():no(Error('Recovery authentication failed')));});done.catch(()=>{});
  const reader=new Cursor(child.stdout);if(!(await reader.exact(magic.length)).equals(magic))throw Error('Unsupported recovery format');const len=(await reader.exact(4)).readUInt32BE();if(len<2||len>maxManifest)throw Error('Recovery manifest budget exceeded');
  const manifest=JSON.parse((await reader.exact(len)).toString('utf8'));
  if(manifest.format!==1||!manifest.quiesced||!manifest.completeForDisasterRecovery||!Array.isArray(manifest.files)||manifest.files.length>50000)throw Error('Invalid recovery manifest');
  const names=new Set();let total=0;
  for(const row of manifest.files){if(!safeName(row.name)||names.has(row.name)||!Number.isSafeInteger(row.size)||row.size<0||!/^[0-9a-f]{64}$/.test(row.sha256))throw Error('Unsafe recovery entry');names.add(row.name);total+=row.size;if(total>maxBytes)throw Error('Recovery size budget exceeded');}
  for(const required of ['database/database.dump','config/application.env','queues/redis.snapshot'])if(!names.has(required))throw Error('Incomplete recovery roles');
  for(const role of ['uploads','profiles'])await mkdir(join(destination,role),{mode:0o700});
  for(const row of manifest.files){const path=join(destination,row.name);await mkdir(dirname(path),{recursive:true,mode:0o700});const file=await open(path,'wx',0o600),hash=createHash('sha256');try{let remaining=row.size;while(remaining){const part=await reader.take(Math.min(65536,remaining));if(!part.length)throw Error('Truncated recovery entry');hash.update(part);await file.writeFile(part);remaining-=part.length;}}finally{await file.close();}if(hash.digest('hex')!==row.sha256)throw Error('Recovery checksum mismatch');}
  if((await reader.take(1)).length)throw Error('Unexpected recovery trailing data');await done;
  // COMMITTED is published only after authenticated decryption and every checksum.
  await writeFile(join(destination,'COMMITTED.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});return{files:manifest.files.length,plaintextBytes:total,releaseCommit:manifest.releaseCommit,completeForDisasterRecovery:true};
 }catch(error){if(child?.exitCode===null)child.kill('SIGTERM');await done?.catch(()=>{});await rm(destination,{recursive:true,force:true});throw error;}
}
async function main(){const [action,specFile,output]=process.argv.slice(2);if(action==='pack'){const spec=JSON.parse(await readFile(specFile,'utf8'));const proof=await createRecoveryBundle(spec,resolve(output),resolve('.secrets/backup.recipient'));console.log(JSON.stringify(proof));return;}if(action==='restore'){const proof=await restoreRecoveryBundle(resolve(specFile),resolve('.secrets/backup.agekey'),resolve(output));console.log(JSON.stringify(proof));return;}throw Error('Use pack snapshot-spec.json output.age or restore input.age NEW_DIRECTORY');}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Recovery operation failed; no services started. Existing backups and destination folders remain unchanged.');process.exitCode=1;});
