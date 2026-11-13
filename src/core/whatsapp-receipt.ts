import { DeliveryError } from "./delivery-policy.js";

/** A resolved browser call alone does not prove that WhatsApp accepted a message. */
export function sentMessageId(message: unknown): string {
  const id = (message as { id?: { _serialized?: unknown; $1?: unknown } } | undefined)?.id;
  const value = id?._serialized ?? id?.$1;
  if (typeof value !== "string" || !value.trim()) {
    throw new DeliveryError("WhatsApp не вернул ID сообщения; результат требует проверки", "ambiguous");
  }
  return value;
}
