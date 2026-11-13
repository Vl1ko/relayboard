import assert from "node:assert/strict";
import test from "node:test";
import { WhatsAppAdapter } from "./adapters/whatsapp.js";
import { classifyDeliveryError } from "./delivery-policy.js";

for (const status of ["starting", "authenticated", "disconnected", "qr", "auth_failure"]) {
  test(`WhatsApp ${status} never starts an outbound send`, async (t) => {
    const calls:string[]=[];
    t.mock.method(globalThis,"fetch",async (url:unknown)=>{
      calls.push(String(url));return Response.json({status});
    });
    await assert.rejects(new WhatsAppAdapter("account-a").send("group",{text:"test",attachments:[]}), error=>{
      assert.equal(classifyDeliveryError(error),["qr","auth_failure"].includes(status)?"auth_required":"waiting");return true;
    });
    assert.equal(calls.length,1);assert.ok(calls[0].endsWith("/status"));
  });
}

test("bridge unavailability before sending is safe to wait for",async t=>{
  t.mock.method(globalThis,"fetch",async()=>{throw new Error("fetch failed")});
  await assert.rejects(new WhatsAppAdapter("account-a").send("group",{text:"test",attachments:[]}),e=>classifyDeliveryError(e)==="waiting");
});

test("the same delivery identifier reaches the bridge, preserving deduplication",async t=>{
  const bodies:unknown[]=[];
  t.mock.method(globalThis,"fetch",async(url:unknown,init:RequestInit)=>{
    if(String(url).endsWith("/status"))return Response.json({status:"ready"});
    bodies.push(JSON.parse(String(init.body)));return Response.json({messageId:"receipt-123"});
  });
  const message={deliveryId:"same-delivery",text:"test",attachments:[]};
  const result=await new WhatsAppAdapter("account-a").send("group",message);
  assert.equal(result.externalMessageId,"receipt-123");
  assert.deepEqual(bodies,[{destinationId:"group",...message}]);
});

test("a bridge timeout after send initiation stays ambiguous",async t=>{
  t.mock.method(globalThis,"fetch",async(url:unknown)=>String(url).endsWith("/status")
    ?Response.json({status:"ready"})
    :Response.json({kind:"ambiguous",error:"Не удалось подтвердить отправку"},{status:503}));
  await assert.rejects(new WhatsAppAdapter("account-a").send("group",{text:"test",attachments:[]}),e=>classifyDeliveryError(e)==="ambiguous");
});

test("connection loss after the POST cannot trigger a blind automatic retry",async t=>{
  t.mock.method(globalThis,"fetch",async(url:unknown)=>{
    if(String(url).endsWith("/status"))return Response.json({status:"ready"});
    throw new Error("fetch failed");
  });
  await assert.rejects(new WhatsAppAdapter("account-a").send("group",{text:"test",attachments:[]}),e=>classifyDeliveryError(e)==="ambiguous");
});

for (const messageId of [undefined, "", " ", 123]) {
  test(`successful HTTP without valid receipt (${JSON.stringify(messageId)}) remains ambiguous`, async t => {
    t.mock.method(globalThis, "fetch", async (url: unknown) => Response.json(
      String(url).endsWith("/status") ? { status: "ready" } : { messageId },
    ));
    await assert.rejects(new WhatsAppAdapter("account-a").send("group", { text: "test", attachments: [] }),
      error => classifyDeliveryError(error) === "ambiguous");
  });
}
