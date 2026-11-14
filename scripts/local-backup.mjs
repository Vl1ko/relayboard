import {spawn} from 'node:child_process';import {pipeline} from 'node:stream/promises';import {Transform} from 'node:stream';import {createWriteStream} from 'node:fs';import {mkdir,chmod,readFile,writeFile,lstat,link,unlink,stat,statfs,rm} from 'node:fs/promises';import {resolve,join,dirname} from 'node:path';import {randomUUID,createHash} from 'node:crypto';import {homedir} from 'node:os';import {pathToFileURL} from 'node:url';
export const agePath=resolve('.tools/age/age'),keygenPath=resolve('.tools/age/age-keygen');
function exit(child){return new Promise((yes,no)=>{child.once('error',()=>no(Error('Backup subprocess could not start')));child.once('exit',code=>code===0?yes():no(Error('Backup subprocess failed')));});}
async function regular(path,privateFile=false){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||privateFile&&(info.mode&0o077)!==0)throw Error('Backup input must be a regular private file');}
export async function initIdentity(identity,recipient,keygen=keygenPath){
 await mkdir(dirname(identity),{recursive:true,mode:0o700});if((await lstat(dirname(identity))).isSymbolicLink())throw Error('Identity folder must not be a symlink');await chmod(dirname(identity),0o700);
 try{await lstat(identity);throw Error('Identity already exists; rotation is never automatic');}catch(e){if(e.code!=='ENOENT')throw e;}
 const child=spawn(keygen,['-o',identity],{stdio:['ignore','ignore','ignore']});await exit(child);await chmod(identity,0o600);await regular(identity,true);
 const publicChild=spawn(keygen,['-y',identity],{stdio:['ignore','pipe','ignore']});let text='';publicChild.stdout.on('data',c=>text+=c);await exit(publicChild);text=text.trim();if(!/^age1[0-9a-z]{58}$/.test(text))throw Error('Unexpected native age recipient');await writeFile(recipient,text+'\n',{flag:'wx',mode:0o600});
}
export async function encryptBackupStream(input,output,recipientFile,{age=agePath,maxBytes=2*1024**3}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('Invalid backup size limit');await regular(recipientFile);const recipient=(await readFile(recipientFile,'utf8')).trim();if(!/^age1[0-9a-z]{58}$/.test(recipient))throw Error('Only a native age recipient is accepted');
 const partial=output+'.partial-'+randomUUID(),child=spawn(age,['--encrypt','--recipient',recipient],{stdio:['pipe','pipe','ignore']});let bytes=0;const hash=createHash('sha256'),limit=new Transform({transform(chunk,_enc,next){bytes+=chunk.length;if(bytes>maxBytes)return next(Error('Backup size limit exceeded'));hash.update(chunk);next(null,chunk);}});
 const finished=exit(child);try{
  await Promise.all([pipeline(input,child.stdin),pipeline(child.stdout,limit,createWriteStream(partial,{flags:'wx',mode:0o600})),finished]);
  // Atomic publish without overwriting an existing backup, even under concurrent runs.
  await link(partial,output);return{bytes,sha256:hash.digest('hex')};
 }finally{if(child.exitCode===null)child.kill('SIGTERM');await unlink(partial).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
const identity=resolve('.secrets/backup.agekey'),recipient=resolve('.secrets/backup.recipient'),backupRoot=resolve('data/backups');
const remote={target:'root@93.89.223.118',identity:join(homedir(),'.ssh/id_ed25519_relayboard'),command:'docker compose --project-directory /opt/relayboard -f /opt/relayboard/docker-compose.yml exec -T postgres pg_dump --username=relayboard --dbname=relayboard --format=custom --compress=6 --no-owner --no-acl'};
async function main(){
 if(JSON.parse(await readFile(resolve('package.json'),'utf8')).name!=='relayboard')throw Error('Run from the Relayboard project root');
 const action=process.argv[2]||'plan';if(action==='init'){await initIdentity(identity,recipient);console.log('Local backup identity created in .secrets; private key was not printed. Keep an offline copy separately.');return;}
 if(action==='plan'){console.log(JSON.stringify({source:remote.target,kind:'database-only',destination:backupRoot,encrypted:true,sourceDatabaseModified:false,extraRecoveryItems:['application encryption key/config','messenger session profiles','unexpired uploads'],executesNow:false},null,2));return;}
 if(action!=='backup-db'||!process.argv.includes('--execute'))throw Error('Use plan, init, or backup-db --execute');
 await regular(identity,true);await regular(recipient);await mkdir(backupRoot,{recursive:true,mode:0o700});if((await lstat(backupRoot)).isSymbolicLink())throw Error('Backup folder must not be a symlink');await chmod(backupRoot,0o700);
 const maxBytes=Number(process.env.BACKUP_MAX_BYTES||2*1024**3),space=await statfs(backupRoot);if(!Number.isSafeInteger(maxBytes)||maxBytes<1048576||maxBytes>10*1024**3||space.bavail*space.bsize<maxBytes+100*1024**2)throw Error('Insufficient local space or invalid backup budget');
 const folder=join(backupRoot,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());await mkdir(folder,{mode:0o700});let source;
 try{
  source=spawn('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-i',remote.identity,remote.target,remote.command],{stdio:['ignore','pipe','ignore']});
  const sourceDone=exit(source);const [proof]=await Promise.all([encryptBackupStream(source.stdout,join(folder,'database.dump.age'),recipient,{maxBytes}),sourceDone]);
  await writeFile(join(folder,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),source:remote.target,kind:'database-only',completeForDisasterRecovery:false,format:'pg-custom+age',...proof},null,2)+'\n',{flag:'wx',mode:0o600});console.log('Encrypted database backup saved locally: '+folder);
 }catch(error){if(source?.exitCode===null)source.kill('SIGTERM');await rm(folder,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Local backup failed; existing backups and source data are unchanged. Inspect prerequisites without printing credentials.');process.exitCode=1;});
