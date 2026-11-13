import { DeliveryError } from "./delivery-policy.js";

/** A resolved browser call alone does not prove that WhatsApp accepted a message. */
export function sentMessageId(message: unknown): string {
  const ack=(message as {ack?:unknown}|undefined)?.ack;
  if(typeof ack!=="number"||!Number.isInteger(ack)||ack<1||ack>4){
    throw new DeliveryError("WhatsApp не подтвердил приём сервером; результат требует проверки", "ambiguous");
  }
  const id = (message as { id?: { _serialized?: unknown; $1?: unknown } } | undefined)?.id;
  const value = id?._serialized ?? id?.$1;
  if (typeof value !== "string" || !value.trim()) {
    throw new DeliveryError("WhatsApp не вернул ID сообщения; результат требует проверки", "ambiguous");
  }
  return value;
}
