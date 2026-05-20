// Registers chats on interaction and updates chat active status.
import type { Bot, Context, MiddlewareFn } from "grammy";

import { type UpsertChatInput } from "~/db/queries";
import { type ChatType, chatTypeValues } from "~/db/schema";

type ChatLike = {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type UserLike = {
  id: number;
};

export type ChatInteractionContext = {
  chat?: ChatLike;
  from?: UserLike;
};

export type ChatMemberStatusContext = {
  chat: ChatLike;
  from?: UserLike;
  newStatus: string;
};

export type ChatRegistrationStore = {
  upsertChat: (input: UpsertChatInput) => Promise<void>;
  setChatActive: (chatId: number, active: boolean) => Promise<void>;
};

const activeStatuses = new Set(["administrator", "member"]);
const inactiveStatuses = new Set(["kicked", "left"]);
const supportedChatTypes = new Set<string>(chatTypeValues);

const defaultStore: ChatRegistrationStore = {
  upsertChat: async (input) => {
    const queries = await import("~/db/queries");
    await queries.upsertChat(input);
  },
  setChatActive: async (chatId, active) => {
    const queries = await import("~/db/queries");
    await queries.setChatActive(chatId, active);
  }
};

const toChatType = (value: string): ChatType | null =>
  supportedChatTypes.has(value) ? (value as ChatType) : null;

const getChatTitle = (chat: ChatLike): string | null => {
  if (chat.title !== undefined) {
    return chat.title;
  }

  if (chat.username !== undefined) {
    return `@${chat.username}`;
  }

  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");

  return name.length > 0 ? name : null;
};

const toUpsertChatInput = (
  chat: ChatLike,
  from?: UserLike
): UpsertChatInput | null => {
  const type = toChatType(chat.type);

  if (type === null) {
    return null;
  }

  return {
    id: chat.id,
    type,
    title: getChatTitle(chat),
    addedByUserId: from?.id ?? null
  };
};

export const registerChatFromInteraction = async (
  context: ChatInteractionContext,
  store: Pick<ChatRegistrationStore, "upsertChat"> = defaultStore
): Promise<void> => {
  if (context.chat === undefined) {
    return;
  }

  const chat = toUpsertChatInput(context.chat, context.from);

  if (chat === null) {
    return;
  }

  await store.upsertChat(chat);
};

export const handleChatMemberStatusChange = async (
  context: ChatMemberStatusContext,
  store: ChatRegistrationStore = defaultStore
): Promise<void> => {
  if (activeStatuses.has(context.newStatus)) {
    await registerChatFromInteraction(context, store);
    await store.setChatActive(context.chat.id, true);
    return;
  }

  if (inactiveStatuses.has(context.newStatus)) {
    await store.setChatActive(context.chat.id, false);
  }
};

export const chatRegistrationMiddleware: MiddlewareFn<Context> = async (
  ctx,
  next
) => {
  await registerChatFromInteraction(ctx);
  await next();
};

export const registerChatLifecycleHandlers = (bot: Bot): void => {
  bot.use(chatRegistrationMiddleware);

  bot.on("my_chat_member", async (ctx) => {
    const update = ctx.myChatMember;

    if (update === undefined) {
      return;
    }

    await handleChatMemberStatusChange({
      chat: update.chat,
      from: update.from,
      newStatus: update.new_chat_member.status
    });
  });
};
