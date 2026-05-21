// Verifies chat lifecycle state decisions before database writes.
import { describe, expect, mock, test } from "bun:test";

import { chatAdminOnly } from "~/bot/middleware/chatAdminOnly";
import {
  handleChatMemberStatusChange,
  registerChatFromInteraction
} from "~/bot/middleware/chatRegistration";

describe("chat registration middleware helpers", () => {
  test("registers an interacting chat as active", async () => {
    const upsertChat = mock(async () => {});

    await registerChatFromInteraction(
      {
        chat: { id: -1001, type: "supergroup", title: "Maintainers" },
        from: { id: 42 }
      },
      { upsertChat }
    );

    expect(upsertChat).toHaveBeenCalledWith({
      id: -1001,
      type: "supergroup",
      title: "Maintainers",
      addedByUserId: 42
    });
  });

  test("ignores interactions without chat context", async () => {
    const upsertChat = mock(async () => {});

    await registerChatFromInteraction({ from: { id: 42 } }, { upsertChat });

    expect(upsertChat).not.toHaveBeenCalled();
  });

  test("activates a chat when the bot becomes a member", async () => {
    const setChatActive = mock(async () => {});
    const upsertChat = mock(async () => {});

    await handleChatMemberStatusChange(
      {
        chat: { id: -1002, type: "group", title: "Core" },
        from: { id: 7 },
        newStatus: "member"
      },
      { setChatActive, upsertChat }
    );

    expect(upsertChat).toHaveBeenCalledWith({
      id: -1002,
      type: "group",
      title: "Core",
      addedByUserId: 7
    });
    expect(setChatActive).toHaveBeenCalledWith(-1002, true);
  });

  test("deactivates a chat when the bot leaves or is kicked", async () => {
    const setChatActive = mock(async () => {});
    const upsertChat = mock(async () => {});

    await handleChatMemberStatusChange(
      {
        chat: { id: -1003, type: "supergroup", title: "Ops" },
        from: { id: 9 },
        newStatus: "kicked"
      },
      { setChatActive, upsertChat }
    );

    expect(upsertChat).not.toHaveBeenCalled();
    expect(setChatActive).toHaveBeenCalledWith(-1003, false);
  });

  test("allows channel post commands without a from user", async () => {
    let nextCalled = false;
    const replies: string[] = [];

    await chatAdminOnly(
      {
        chat: { id: -1004, type: "channel", title: "Releases" },
        channelPost: {
          message_id: 10,
          date: 1,
          chat: { id: -1004, type: "channel", title: "Releases" },
          text: "/subscribe octocat"
        },
        reply: async (text: string) => {
          replies.push(text);

          return {} as never;
        }
      } as never,
      async () => {
        nextCalled = true;
      }
    );

    expect(nextCalled).toBe(true);
    expect(replies).toEqual([]);
  });
});
