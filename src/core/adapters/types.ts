export type OutgoingMessage = {
  text: string;
  attachments: OutgoingAttachment[];
};

export type OutgoingAttachment = {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export type SendResult = {
  externalMessageId: string;
};

export interface MessengerAdapter {
  send(destinationId: string, message: OutgoingMessage): Promise<SendResult>;
}
