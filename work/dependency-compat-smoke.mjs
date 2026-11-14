// No WhatsApp navigation/login; only isolated temp files and package API compatibility.
import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {createReadStream,createWriteStream} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pipeline} from 'node:stream/promises';
const require=createRequire(import.meta.url),sdkRequire=createRequire(require.resolve('whatsapp-web.js/package.json'));
const sdk=sdkRequire('whatsapp-web.js'),puppeteer=sdkRequire('puppeteer'),archiver=sdkRequire('archiver'),unzipper=sdkRequire('unzipper');
const utils=createRequire(sdkRequire.resolve('archiver'))('archiver-utils');
const root=await mkdtemp(join(tmpdir(),'relayboard-dependency-compat-'));
try{
 assert.equal(typeof puppeteer.launch,'function');assert.equal(typeof puppeteer.connect,'function');
 const local=new sdk.LocalAuth({clientId:'synthetic-dependency-compat',dataPath:join(root,'local-auth')});const client=new sdk.Client({authStrategy:local,puppeteer:{headless:true,executablePath:'/synthetic/not-launched'}});assert.ok(client);
 const remote=new sdk.RemoteAuth({clientId:'synthetic-dependency-compat',dataPath:join(root,'remote-auth'),backupSyncIntervalMs:60000,store:{sessionExists:async()=>false,save:async()=>{},extract:async()=>{},delete:async()=>{}}});assert.ok(remote);
 const input=join(root,'input'),output=join(root,'output');await mkdir(input);await mkdir(output);await writeFile(join(input,'synthetic.txt'),'Synthetic archive compatibility');
 assert.deepEqual(utils.file.expand({cwd:input},'**/*.txt'),['synthetic.txt']);
 const archive=archiver('zip'),path=join(root,'synthetic.zip'),written=pipeline(archive,createWriteStream(path));archive.directory(input,false);await archive.finalize();await written;
 await createReadStream(path).pipe(unzipper.Extract({path:output})).promise();assert.equal(await readFile(join(output,'synthetic.txt'),'utf8'),'Synthetic archive compatibility');
 console.log('PASS: WhatsApp CommonJS SDK consumes Puppeteer, LocalAuth/RemoteAuth constructors and scoped glob/archive/extraction round-trip remain compatible; no browser login, profile access or network');
}finally{await rm(root,{recursive:true,force:true});}
