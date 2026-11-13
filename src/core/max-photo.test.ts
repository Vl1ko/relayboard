import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadMaxPhoto, sendMaxPhotoMessage, type MaxTransport } from "./adapters/max-photo.js";
import { classifyDeliveryError } from "./delivery-policy.js";

const dir = await mkdtemp(join(tmpdir(), "relayboard-photo-"));
const path = join(dir, "test.png");
await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC", "base64"));
const photo = { path, name: "фото.png", mimeType: "image/png", sizeBytes: 74 };
after(() => rm(dir, { recursive: true, force: true }));

test("current MAX URL without photoIds uploads first and sends the returned photo token", async t => {
  const opcodes: number[] = [];
  let uploaded = false;
  const ws: MaxTransport = { async send(opcode, payload) {
    opcodes.push(opcode);
    if (opcode === 80) return { url: "https://iu.oneme.ru/uploadImage?r=signed" };
    assert.equal(uploaded, true);
    assert.deepEqual((payload.message as { attaches: unknown }).attaches, [{ _type: "PHOTO", photoToken: "test-token" }]);
    return { message: { id: "sent-id" } };
  } };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const file = (init.body as FormData).get("file") as File;
    assert.equal(file.name, photo.name); assert.equal(file.type, photo.mimeType);
    assert.ok(file.size > 0); assert.ok(init.signal);
    uploaded = true;
    return Response.json({ photos: { "new-photo-id": { token: "test-token" } } });
  });
  assert.deepEqual(await sendMaxPhotoMessage(ws, 123, { text: "caption", attachments: [photo] }, 60000), { externalMessageId: "sent-id" });
  assert.deepEqual(opcodes, [80, 64]);
});

test("legacy photoIds URLs remain supported", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ photos: { "legacy-id": { token: "legacy-token" } } }));
  assert.deepEqual(await uploadMaxPhoto({ send: async () => ({ url: "https://iu.oneme.ru/uploadImage?photoIds=legacy-id" }) }, photo, AbortSignal.timeout(1000)), { _type: "PHOTO", photoToken: "legacy-token" });
});

test("several photos are uploaded before the single message is published", async t => {
  let uploads=0;
  const opcodes:number[]=[];
  t.mock.method(globalThis,"fetch",async()=>Response.json({photos:{id:{token:`photo-${++uploads}`}}}));
  const ws:MaxTransport={send:async(opcode,payload)=>{
    opcodes.push(opcode);
    if(opcode===80)return{url:"https://iu.oneme.ru/uploadImage?r=signed"};
    assert.deepEqual((payload.message as {attaches:unknown}).attaches,[{_type:"PHOTO",photoToken:"photo-1"},{_type:"PHOTO",photoToken:"photo-2"}]);
    return{message:{id:"album-id"}};
  }};
  await sendMaxPhotoMessage(ws,123,{text:"album",attachments:[photo,photo]},60000);
  assert.deepEqual(opcodes,[80,80,64]);
});

test("a late upload cannot publish after the worker's send deadline",async t=>{
  const opcodes:number[]=[];
  t.mock.method(globalThis,"fetch",async()=>{
    await new Promise(resolve=>setTimeout(resolve,1100));
    return Response.json({photos:{id:{token:"late-token"}}});
  });
  const ws:MaxTransport={send:async opcode=>{opcodes.push(opcode);return{url:"https://iu.oneme.ru/uploadImage?r=signed"}}};
  await assert.rejects(sendMaxPhotoMessage(ws,123,{text:"caption",attachments:[photo]},5000),error=>classifyDeliveryError(error)==="transient");
  assert.deepEqual(opcodes,[80]);
});

for (const body of [ { error_code: "503", error_data: "IMAGE_INVALID_FORMAT" }, { photos: {} }, { photos: { a: { token: "a" }, b: { token: "b" } } } ]) {
  test(`rejected or ambiguous upload never publishes a message: ${JSON.stringify(body)}`, async t => {
    const opcodes: number[] = [];
    t.mock.method(globalThis, "fetch", async () => Response.json(body));
    const ws: MaxTransport = { send: async opcode => { opcodes.push(opcode); return { url: "https://iu.oneme.ru/uploadImage?r=signed" }; } };
    await assert.rejects(sendMaxPhotoMessage(ws, 123, { text: "caption", attachments: [photo] }, 60000), error => classifyDeliveryError(error) === "permanent");
    assert.deepEqual(opcodes, [80]);
  });
}

test("an upload HTTP failure does not send the text without its photo", async t => {
  const opcodes: number[] = [];
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
  const ws: MaxTransport = { send: async opcode => { opcodes.push(opcode); return { url: "https://iu.oneme.ru/uploadImage?r=signed" }; } };
  await assert.rejects(sendMaxPhotoMessage(ws, 123, { text: "caption", attachments: [photo] }, 60000), error => classifyDeliveryError(error) === "transient");
  assert.deepEqual(opcodes, [80]);
});

test("missing acknowledgement after publishing remains ambiguous", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ photos: { a: { token: "test-token" } } }));
  const ws: MaxTransport = { send: async opcode => opcode === 80 ? { url: "https://iu.oneme.ru/uploadImage?r=signed" } : {} };
  await assert.rejects(sendMaxPhotoMessage(ws, 123, { text: "caption", attachments: [photo] }, 60000), error => classifyDeliveryError(error) === "ambiguous");
});
