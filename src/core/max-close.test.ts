import test from 'node:test';import assert from 'node:assert/strict';import{createRequire}from'node:module';import{once}from'node:events';import{createServer}from'node:http';import{closeMaxClient}from'./max-close.js';
const require=createRequire(import.meta.url),WebSocket=require('ws');
test('cancel during a real WebSocket handshake settles error listeners without crashing owner',async()=>{
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
 const socket=new WebSocket('ws://127.0.0.1:'+port);let originalError=false,closedSdk=false;
 socket.once('error',()=>{originalError=true;});const done=new Promise<void>(resolve=>socket.once('close',()=>resolve()));
 const client={ws:{socket},close(){closedSdk=true;this.ws.socket?.removeAllListeners();this.ws.socket?.close();}};
 try{closeMaxClient(client);await done;assert.equal(originalError,true);assert.equal(closedSdk,true);assert.equal(client.ws.socket,null);closeMaxClient(client);}finally{server.close();}
});
