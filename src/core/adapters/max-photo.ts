import {nextMaxCid} from '../max-cid.js';
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { OutgoingAttachment, OutgoingMessage, SendResult } from "./types.js";
import { DeliveryError } from "../delivery-policy.js";
import { WsError } from "@ounezz/umax";

/** A correlated negative server reply proves this publication was not accepted. */
export class MaxPublicationRejected extends DeliveryError {
  readonly code: 'max_chat_denied'|'max_rate_limited';
  constructor(readonly wireCode:'chat.denied'|'too.many.requests') {
    super(wireCode==='chat.denied'?'MAX: нет прав отправки сообщений в этот чат':'MAX ограничил частоту отправки; публикация ожидает',wireCode==='chat.denied'?'permanent':'waiting');
    this.code=wireCode==='chat.denied'?'max_chat_denied':'max_rate_limited';
  }
}

export interface MaxTransport {
  send(opcode: number, payload: Record<string, unknown>, timeout?: number): Promise<unknown>;
}

export async function uploadMaxPhoto(ws: MaxTransport, photo: OutgoingAttachment, signal: AbortSignal) {
  const bytes = await readFile(photo.path);
  signal.throwIfAborted();
  const slot = await ws.send(80, { count: 1, profile: false }, 15_000) as { url?: string };
  if (typeof slot.url !== "string") throw new DeliveryError("MAX не выдал ссылку загрузки фото", "transient");
  signal.throwIfAborted();
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: photo.mimeType }), photo.name);
  const response = await fetch(slot.url, { method: "POST", body: form, signal });
  if (!response.ok) throw new DeliveryError(`Загрузка фото MAX: HTTP ${response.status}`,
    response.status >= 500 || response.status === 429 ? "transient" : "permanent");
  const body = await response.json() as { photos?: Record<string, { token?: unknown }>; error_code?: unknown; error_data?: unknown };
  if (body.error_code != null) {
    const code = typeof body.error_data === "string" && /^[A-Z_]+$/.test(body.error_data) ? body.error_data : "UPLOAD_REJECTED";
    throw new DeliveryError(`MAX отклонил изображение: ${code}`, code === "IMAGE_INVALID_FORMAT" ? "permanent" : "transient");
  }
  // Current uploadImage URLs only contain a signed `r` parameter. The photo
  // identifier is returned as a key in the multipart response, after upload.
  const photos = body.photos && typeof body.photos === "object" ? body.photos : {};
  const legacyId = new URL(slot.url).searchParams.get("photoIds");
  const values = Object.values(photos);
  const token = legacyId && photos[legacyId] ? photos[legacyId].token : values.length === 1 ? values[0]?.token : undefined;
  if (typeof token !== "string" || !token) throw new DeliveryError("MAX не вернул однозначный токен загруженного фото", "permanent");
  return { _type: "PHOTO", photoToken: token };
}

export async function prepareMaxMediaMessage(ws: MaxTransport, chatId: number, message: OutgoingMessage, timeoutMs: number, beforeSend?:()=>void): Promise<() => Promise<SendResult>> {
  const budget = Math.max(1000, timeoutMs - 5000);
  const deadline = Date.now() + budget;
  const signal = AbortSignal.timeout(budget);
  const attaches: Record<string, unknown>[] = [];
  try {
    for (const photo of message.attachments.filter(a => a.mimeType.startsWith("image/"))) {
      attaches.push(await uploadMaxPhoto(ws, photo, signal));
    }
    const others = message.attachments.filter(a => !a.mimeType.startsWith("image/"));
    if (others.length) {
      // Preserve the pinned client's video/file upload protocol for mixed posts.
      const entry = pathToFileURL(createRequire(import.meta.url).resolve("@ounezz/umax"));
      const uploads = await import(new URL("./message/upload.js", entry).href);
      for (const item of others) {
        signal.throwIfAborted();
        attaches.push(await (item.mimeType.startsWith("video/") ? uploads.upload_video(ws, item.path) : uploads.upload_file(ws, item.path)));
      }
    }
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) throw new DeliveryError("Загрузка вложений MAX превысила время ожидания; сообщение не отправлено", "transient");
    throw error;
  }
  return () => {
    if (signal.aborted || Date.now()>=deadline) throw new DeliveryError("Подготовка MAX истекла до отправки", "transient");
    beforeSend?.();
    let response:Promise<unknown>;
    try { response=ws.send(64, {chatId,message:{text:message.text,cid:nextMaxCid(),elements:[],attaches},notify:true},Math.max(1,deadline-Date.now())); }
    catch { throw new DeliveryError("MAX не подтвердил результат начатой отправки", "ambiguous"); }
    return response.then(body=>{
      const result=body as {message?:{id?:unknown}};
      if(result?.message?.id==null||!String(result.message.id).trim())throw new DeliveryError("MAX не подтвердил идентификатор отправленного сообщения", "ambiguous");
      return {externalMessageId:String(result.message.id)};
    },error=>{
      const code=error instanceof WsError&&error.opcode===64?(error.payload as {error?:unknown})?.error:undefined;
      if(code==='chat.denied'||code==='too.many.requests')throw new MaxPublicationRejected(code);
      throw new DeliveryError("MAX не подтвердил результат начатой отправки", "ambiguous");
    });
  };
}

export async function sendMaxPhotoMessage(ws:MaxTransport,chatId:number,message:OutgoingMessage,timeoutMs:number):Promise<SendResult>{
 return (await prepareMaxMediaMessage(ws,chatId,message,timeoutMs))();
}
