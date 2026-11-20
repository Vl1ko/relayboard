import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {browserOriginGuard} from './browser-origin.js';
test('cookie API and login reject unrelated and same-site sibling origins before handling body',async()=>{
 const app=express();app.use(browserOriginGuard({publicAppUrl:'https://relayboard.example'}));let mutations=0;app.all('/api/test',(_req,res)=>{mutations++;res.json({ok:true});});const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
 try{
  for(const origin of ['https://evil.example','https://sibling.relayboard.example','https://relayboard.example.evil','null','http://relayboard.example','https://user:secret@relayboard.example']){const r=await fetch(base+'/api/test',{method:'POST',headers:{origin}});assert.equal(r.status,403,origin);assert.equal(r.headers.get('access-control-allow-origin'),null);}
  assert.equal(mutations,0);const allowed=await fetch(base+'/api/test',{method:'POST',headers:{origin:'https://relayboard.example'}});assert.equal(allowed.status,200);assert.equal(allowed.headers.get('access-control-allow-origin'),'https://relayboard.example');assert.equal(mutations,1);
  const preflight=await fetch(base+'/api/test',{method:'OPTIONS',headers:{origin:'https://relayboard.example'}});assert.equal(preflight.status,204);assert.equal(mutations,1);
  assert.equal((await fetch(base+'/api/test',{headers:{'sec-fetch-site':'cross-site'}})).status,403);assert.equal((await fetch(base+'/api/test')).status,200);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
