import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pack} from 'msgpackr';
import {createRequire} from 'node:module';
const WebSocket=createRequire(import.meta.url)('ws');

const entry=import.meta.resolve('@ounezz/umax');
const {encodeFrame,decodeFrame,decodeLz4}=await import(new URL('./ws/binary.js',entry).href);
const {Ws}=await import(new URL('./ws/index.js',entry).href);

// Build server frames independently of the client's encoder.
function reply(body:Buffer,flags=0,cmd=1,seq=1,opcode=19){
 const header=Buffer.alloc(10);header[0]=10;header[1]=cmd;
 header.writeUInt16BE(seq,2);header.writeUInt16BE(opcode,4);
 header[6]=flags;header.writeUIntBE(body.length,7,3);
 return Buffer.concat([header,body]);
}
function literalBlock(body:Buffer){
 const length=body.length,extra:number[]=[];
 if(length>=15){let n=length-15;while(n>=255){extra.push(255);n-=255;}extra.push(n);}
 return Buffer.concat([Buffer.from([Math.min(length,15)<<4,...extra]),body]);
}
test('MAX login: all nonzero compression flags decode LZ4 before MessagePack',()=>{
 const login={profile:{contact:{id:123}},chats:[{id:-456,type:'CHAT',participants:{123:456}}],contacts:[]};
 for(const flag of [0,1,2,3,9]){
  const body=pack(login);
  assert.deepEqual(decodeFrame(reply(flag?literalBlock(body):body,flag)).payload,login);
 }
});
test('MAX extension IDs and participant map keys preserve signed and wide integers',()=>{
 // {id: ext1(int64 -123), participants: {ext1(uint64 123): 1}, messageId: uint64 MAX_INT64}
 const bytes=Buffer.from('83a26964c70901d3ffffffffffffff85ac7061727469636970616e747381c70901cf000000000000007b01a96d6573736167654964cf7fffffffffffffff','hex');
 assert.deepEqual(decodeFrame(reply(bytes)).payload,{id:-123,participants:{123:1},messageId:'9223372036854775807'});
});
test('MAX outgoing requests use ext1 IDs but keep counts/timestamps as integers',()=>{
 const original={chatId:-123,message:{cid:456,text:'тест',attaches:[]},contactIds:[789],from:1700000000000,backward:2};
 const frame=encodeFrame(0,65535,64,original);
 assert.equal(frame.readUInt16BE(2),65535);
 const body=frame.subarray(10);
 assert.ok(body.includes(Buffer.from('c70901d3ffffffffffffff85','hex')));
 assert.ok(body.includes(Buffer.from('c70901cf00000000000001c8','hex')));
 assert.ok(body.includes(Buffer.from('a466726f6dd30000018bcfe56800','hex')));
 assert.deepEqual(decodeFrame(frame).payload,original);
 assert.throws(()=>encodeFrame(0,1,49,{chatId:Number.MAX_SAFE_INTEGER+1}),/unsafe ID/);
});
test('MAX decoder accepts scalar prefixes and rejects invalid/truncated frames',()=>{
 assert.deepEqual(decodeFrame(reply(Buffer.concat([pack(0),pack({ok:true})]))).payload,{ok:true});
 assert.throws(()=>decodeFrame(Buffer.alloc(9)),/header/);
 const invalid=reply(pack({ok:true}));invalid.writeUIntBE(999,7,3);
 assert.throws(()=>decodeFrame(invalid),/length/);
 assert.throws(()=>decodeFrame(reply(Buffer.from([0xc1]))));
 assert.throws(()=>decodeFrame(reply(pack(123))),/payload map/);
});
test('MAX LZ4 handles overlapping copies and rejects invalid offsets/expansion',()=>{
 assert.equal(decodeLz4(Buffer.from([0x15,0x61,1,0])).toString(),'aaaaaaaaaa');
 assert.throws(()=>decodeLz4(Buffer.from([0,0,0])),/offset/);
 assert.throws(()=>decodeLz4(Buffer.from([0xf0,255])),/length/);
 assert.throws(()=>decodeLz4(Buffer.from([0x20,1])),/literals/);
 assert.throws(()=>decodeLz4(Buffer.concat([Buffer.from([0xf0]),Buffer.alloc(66000,255),Buffer.from([0])])),/too large/);
});
test('MAX sequence wraps on the wire, skips pending requests, and matches opcode',async()=>{
 const ws=new Ws();
 ws.seq=65535;
 ws.pending.set(1,{opcode:19,resolve:()=>{},reject:()=>{}});
 let request:any;
 ws.socket={readyState:WebSocket.OPEN,send:(raw:Buffer)=>{request=decodeFrame(raw);}};
 const pending=ws.send(49,{chatId:-123},200);
 assert.equal(request.seq,2);
 ws.receive(reply(pack({wrong:true}),0,1,2,64));
 assert.ok(ws.pending.has(2));
 ws.receive(reply(pack({messages:[]}),0,1,2,49));
 assert.deepEqual(await pending,{messages:[]});
});
test('MAX write failures remove pending requests and server errors reject',async()=>{
 const ws=new Ws();ws.socket={readyState:WebSocket.OPEN,send:()=>{throw Error('send failed');}};
 await assert.rejects(ws.send(49,{},200),/send failed/);
 assert.equal(ws.pending.size,0);
 ws.socket.send=(raw:Buffer)=>{const req=decodeFrame(raw);ws.receive(reply(pack({error:'auth.invalid',message:'Invalid token'}),0,3,req.seq,req.opcode));};
 await assert.rejects(ws.send(19,{},200),/Invalid token/);
 assert.equal(ws.pending.size,0);
});
