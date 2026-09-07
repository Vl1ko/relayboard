import { randomUUID } from "node:crypto";
import type { MessengerAdapter, OutgoingMessage, SendResult } from "./types.js";

export class FakeAdapter implements MessengerAdapter {
  async send(_destinationId: string, _message: OutgoingMessage): Promise<SendResult> {
    return { externalMessageId: `fake-${randomUUID()}` };
  }
}
