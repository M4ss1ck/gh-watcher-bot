// Custom error classes for cases where callers want to discriminate by type.

export class ChatAdminRequiredError extends Error {
  readonly chatId: number;
  readonly userId: number;

  constructor(chatId: number, userId: number) {
    super("chat admin required");
    this.name = "ChatAdminRequiredError";
    this.chatId = chatId;
    this.userId = userId;
  }
}
