export type OutgoingMessage = {
  text: string;
  mediaUrl?: string | null;
};

export type SendResult = {
  externalMessageId: string;
};

export interface MessengerAdapter {
  send(destinationId: string, message: OutgoingMessage): Promise<SendResult>;
}
