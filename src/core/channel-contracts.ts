import { createHash } from "node:crypto";
import { z } from "zod";

// External identifiers are opaque: reject blank values, never silently normalize them.
const identity = z.string().min(1).max(512).refine(value => value.trim().length > 0, "Identity is blank");
export const channelMessageSchema = z.object({
  version: z.literal(1),
  platform: z.enum(["max", "whatsapp"]),
  accountId: identity,
  conversationId: identity,
  messageId: identity,
  occurredAt: z.string().datetime({ offset: true }),
  direction: z.enum(["inbound", "outbound"]),
  origin: z.enum(["customer", "service", "human", "unresolved"]),
  text: z.string(),
}).passthrough().superRefine((event, context) => {
  const invalid = event.origin === "customer" && event.direction !== "inbound"
    || ["service", "human"].includes(event.origin) && event.direction !== "outbound";
  if (invalid) context.addIssue({ code: "custom", path: ["origin"], message: "Origin conflicts with direction" });
});
export type ChannelMessage = z.infer<typeof channelMessageSchema>;

export type OriginEvidence = "remote_sender" | "service_receipt" | "native_human" | "unresolved";

/** Only a connector's verified evidence may assign origin; fromMe alone is insufficient. */
export function resolveMessageOrigin(direction: ChannelMessage["direction"], evidence: OriginEvidence): ChannelMessage["origin"] {
  if (direction === "inbound" && evidence === "remote_sender") return "customer";
  if (direction === "outbound" && evidence === "service_receipt") return "service";
  if (direction === "outbound" && evidence === "native_human") return "human";
  return "unresolved";
}

/** Transport dedup only; does not define contact identity or a business request. */
export function channelMessageKey(input: unknown): string {
  const event = channelMessageSchema.parse(input);
  const scope = JSON.stringify([event.version, event.platform, event.accountId, event.conversationId, event.messageId]);
  return "channel-message:v1:" + createHash("sha256").update(scope).digest("hex");
}

/** Classification only: callers still need opt-out/mode/generation/authorization guards. */
export function messageDisposition(input: unknown) {
  const event = channelMessageSchema.parse(input);
  switch (event.origin) {
    case "customer": return "process_customer" as const;
    case "service": return "suppress_service_echo" as const;
    case "human": return "takeover" as const;
    default: return "hold_for_review" as const;
  }
}

const operation = z.object({ operationId: identity, code: identity });
export const channelSendOutcomeSchema = z.discriminatedUnion("outcome", [
  operation.extend({
    outcome: z.literal("confirmed"),
    externalMessageId: identity,
    retryCondition: z.literal("never"),
  }).passthrough(),
  operation.extend({
    outcome: z.literal("rejected"),
    dispatchState: z.literal("not_started"),
    retryCondition: z.enum(["never", "refresh_auth", "after_delay"]),
  }).passthrough(),
  operation.extend({
    outcome: z.literal("unknown"),
    retryCondition: z.literal("reconcile_or_manual_review"),
  }).passthrough(),
]);
export type ChannelSendOutcome = z.infer<typeof channelSendOutcomeSchema>;

/** Unknown/confirmed actions cannot be replayed automatically. Rejected still needs fresh guards. */
export function permitsAutomaticRetry(input: unknown): boolean {
  const outcome = channelSendOutcomeSchema.parse(input);
  return outcome.outcome === "rejected" && outcome.retryCondition !== "never";
}
