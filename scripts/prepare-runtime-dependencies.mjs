import {readFile,writeFile,rm,copyFile,mkdir,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve('node_modules/node-webpmux'),pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
if(pkg.version!=='3.2.1')throw Error('Review node-webpmux runtime preparation for the new version');
const path=join(root,'libwebp.js'),original=await readFile(path,'utf8'),needle="const libwebpF = require('./libwebp/libwebp.js');",marker='RELAYBOARD_DISABLED_UNUSED_PIXEL_CODEC';
if(process.argv.includes('--check')){
 const alias=JSON.parse(await readFile(resolve('node_modules/buffers/package.json'),'utf8'));
 if(!original.includes(marker)||alias.name!=='node-buffers'||alias.license!=='MIT/X11')throw Error('Run npm ci with the reviewed runtime preparation');
 try{await lstat(join(root,'libwebp'));throw Error('Unused compiled pixel codec must not be distributed');}catch(error){if(error.code!=='ENOENT')throw error;}
 await readFile(join(root,'COPYING.GPL-3'));process.exit(0);
}
if(!original.includes(marker)){
 if(!original.includes(needle))throw Error('Unexpected node-webpmux source');
 await writeFile(path,original.replace(needle,`// ${marker}: modified by Relayboard, 2026-11-15.\n// Pure JS WebP parsing/muxing stays available; pixel encoding/decoding is not exposed by Relayboard.\nconst libwebpF = async () => { throw new Error('Relayboard does not enable the optional node-webpmux pixel codec'); };`));
}
// The application uses Chromium for image preparation. Do not redistribute the
// unused compiled WASM codec whose upstream package omits a reproducible build.
await rm(join(root,'libwebp'),{recursive:true,force:true});
await writeFile(join(root,'RELAYBOARD-MODIFICATIONS.txt'),'Modified 2026-11-15 by Relayboard: disabled optional pixel codec loader and removed its unused compiled directory. Pure JavaScript WebP parsing/muxing is unchanged. All distributed library code is source JavaScript. Reproduce with scripts/prepare-runtime-dependencies.mjs after npm ci. Library remains LGPL-3.0-or-later; replace node_modules/node-webpmux with a compatible library to use a modified version.\n');
const licenses=resolve('docs/licenses');await mkdir(licenses,{recursive:true});
await copyFile(join(root,'COPYING.LESSER'),join(licenses,'LGPL-3.0.txt'));
await copyFile(join(licenses,'GPL-3.0.txt'),join(root,'COPYING.GPL-3'));
for(const [module,name] of [['react','React.txt'],['react-dom','ReactDOM.txt'],['scheduler','Scheduler.txt']])await copyFile(resolve('node_modules',module,'LICENSE'),join(licenses,name));
const lock=JSON.parse(await readFile(resolve('package-lock.json'),'utf8')),inventory=[];
for(const [path,item] of Object.entries(lock.packages)){
 if(!path.startsWith('node_modules/')||item.dev)continue;
 try{const installed=JSON.parse(await readFile(resolve(path,'package.json'),'utf8'));inventory.push({path,name:installed.name,version:installed.version,license:installed.license??'see package license file',integrity:item.integrity??null});}catch(error){if(error.code!=='ENOENT')throw error;}
}
await writeFile(join(licenses,'runtime-dependencies.json'),JSON.stringify({platform:process.platform,arch:process.arch,packages:inventory},null,2)+'\n');
