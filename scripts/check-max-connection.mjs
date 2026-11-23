// Read-only protocol probe. Uses stdin token, or the existing encrypted account
// with --stored-account. Never prints credentials, chat names or message text.
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {UMax} from '@ounezz/umax';

let expectedId,token,stage='credentials';
if(process.argv.includes('--stored-account')){
 const {default:pg}=await import('pg');
 const {decryptCredentials}=await import('../dist-node/core/crypto.js');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 try{
  const row=(await pool.query("SELECT credential_ciphertext,max_self_id FROM integrations WHERE platform='max' AND enabled AND auth_error IS NULL ORDER BY id LIMIT 1")).rows[0];
  if(!row)throw Error('No enabled MAX account');
  token=decryptCredentials(row.credential_ciphertext).token;expectedId=row.max_self_id;
 }finally{await pool.end();}
}else token=readFileSync(0,'utf8').trim();
if(!token||/\s/.test(token))throw Error('Invalid MAX token input');
const client=new UMax(token);
client.chats.subscribe_all=()=>{};
const deadline=setTimeout(()=>{console.log(JSON.stringify({failedAt:stage,reason:'probe_timeout'}));client.close();process.exitCode=1;},45000);
try{
 stage='login';await client.connect();
 if(!client.account?.id||(expectedId!=null&&String(expectedId)!==String(client.account.id)))throw Error('Account identity mismatch');
 const groups=client.chats.list.filter(c=>c.type==='CHAT');
 console.log(JSON.stringify({login:true,identityVerified:true,chats:client.chats.list.length,groups:groups.length}));
 const target=groups.find(c=>c.title.trim().toLowerCase()==='тестовая')??groups[0]??client.chats.list[0];
 if(target){
  stage='metadata';const metadata=await client.ws.send(48,{chatIds:[target.id]},7000);
  if(!metadata?.chats?.some(c=>String(c.id)===String(target.id)))throw Error('Chat metadata mismatch');
  stage='history';const history=await client.ws.send(49,{chatId:target.id,from:Date.now(),backward:2,forward:0,getMessages:true},7000);
  if(!Array.isArray(history?.messages))throw Error('Invalid history response');
  console.log(JSON.stringify({metadata:true,history:true,messages:history.messages.length}));
 }
 stage='keepalive';await client.ws.send(1,{interactive:true},5000);
 if(process.argv.includes('--keepalive'))await delay(27000);
 if(!client.ws.connected)throw Error('Connection did not remain open');
 console.log(JSON.stringify({keepalive:true,connected:true}));
}catch(error){console.log(JSON.stringify({failedAt:stage,reason:error.name,opcode:error.opcode}));process.exitCode=1;}
finally{clearTimeout(deadline);client.close();}
