export type DeliveryErrorKind = "transient" | "permanent" | "ambiguous" | "waiting" | "auth_required";

export class DeliveryError extends Error {
  constructor(message: string, public readonly kind: DeliveryErrorKind) { super(message); }
}

export function isAuthorizationError(error: unknown) {
  const value = error as { message?: string; payload?: { error?: string; message?: string } } | null;
  return value?.payload?.error === "login.token" || value?.payload?.message === "FAIL_LOGIN_TOKEN"
    || /FAIL_LOGIN_TOKEN|login\.token|Ошибка входа.*авториз|invalid token|сессия.*истек/i.test(value?.message || "");
}

const PERMANENT = [
  /not found/i,
  /forbidden/i,
  /нет прав/i,
  /заблокирован/i,
  /unauthori[sz]ed/i,
  /сессия.*истек/i,
  /не подключ[её]н/i,
  /invalid (peer|chat|destination)/i,
  /HTTP 40[13]/i,
];

const AMBIGUOUS = [
  /timeout/i,
  /timed out/i,
  /socket hang up/i,
  /econnreset/i,
  /connection reset/i,
  /неизвестн.*результат/i,
];

export function classifyDeliveryError(error: unknown): DeliveryErrorKind {
  if (error instanceof DeliveryError) return error.kind;
  if (isAuthorizationError(error)) return "auth_required";
  const message = error instanceof Error ? error.message : String(error);
  if (PERMANENT.some((pattern) => pattern.test(message))) return "permanent";
  if (AMBIGUOUS.some((pattern) => pattern.test(message))) return "ambiguous";
  return "transient";
}

export function deliveryErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}
