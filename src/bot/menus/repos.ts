// Defines the repo picker menu for narrowing a subscription to specific repos.
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";

import { getGitHubClient } from "~/bot/menus/deps";
import { filtersMenuId, reposMenuId } from "~/bot/menus/ids";
import { menuKeyFromContext } from "~/bot/menus/root";
import {
  clearRepoDraft,
  getRepoDraft,
  getSelectedSubscription,
  setRepoDraft,
  updateSelectedSubscription
} from "~/bot/menus/state";
import { requireChatAdminCallback } from "~/bot/middleware/chatAdminOnly";
import {
  updateSubscriptionSelectedRepos,
  upsertGitHubRepo
} from "~/db/queries";
import type { GitHubRepoListItem } from "~/github/types";
import { logger } from "~/lib/logger";

const pageSize = 8;
const repoCache = new Map<string, GitHubRepoListItem[]>();
const repoPages = new Map<string, number>();

export const formatRepoSelectionLabel = (selectedRepos: string[] | null): string =>
  selectedRepos === null
    ? "📁 Repos: all"
    : `📁 Repos: ${selectedRepos.length} selected`;

const cacheKey = (chatId: number, userId: number): string => `${chatId}:${userId}`;

const getPage = (id: string): number => repoPages.get(id) ?? 0;

const setPage = (id: string, page: number): void => {
  repoPages.set(id, Math.max(0, page));
};

const loadRepos = async (
  key: { chatId: number; userId: number },
  owner: string
): Promise<GitHubRepoListItem[]> => {
  const id = cacheKey(key.chatId, key.userId);
  const cached = repoCache.get(id);

  if (cached !== undefined) {
    return cached;
  }

  const client = getGitHubClient();

  if (client === null) {
    return [];
  }

  const repos = await client.listRepos(owner);
  repoCache.set(id, repos);

  return repos;
};

const toggleRepo = (
  key: { chatId: number; userId: number },
  repoName: string
): void => {
  const draft = getRepoDraft(key);

  if (draft === null) {
    setRepoDraft(key, [repoName]);
    return;
  }

  const next = draft.includes(repoName)
    ? draft.filter((name) => name !== repoName)
    : [...draft, repoName].sort();

  setRepoDraft(key, next.length === 0 ? [] : next);
};

const saveRepoDraft = async (ctx: Context): Promise<void> => {
  const key = menuKeyFromContext(ctx);
  const state = key === null ? null : getSelectedSubscription(key);

  if (key === null || state === null) {
    await ctx.answerCallbackQuery({ text: "Subscription state lost. Open /subscribe again." });
    return;
  }

  const selectedRepos = getRepoDraft(key);

  try {
    if (selectedRepos !== null) {
      const repos = await loadRepos(key, state.accountLogin);
      const selected = new Set(selectedRepos);

      for (const repo of repos.filter((item) => selected.has(item.name))) {
        await upsertGitHubRepo({
          id: repo.id,
          accountId: state.accountId,
          name: repo.name
        });
      }
    }

    await updateSubscriptionSelectedRepos(state.id, selectedRepos);
    updateSelectedSubscription(key, { selectedRepos });
    clearRepoDraft(key);
    await ctx.editMessageText("Filters");
  } catch (error) {
    logger.error({ err: error, subscription_id: state.id }, "repo selection save failed");
    await ctx.answerCallbackQuery({ text: "Save failed. Try again." });
  }
};

export const reposMenu = new Menu<Context>(reposMenuId)
  .dynamic(async (ctx, range) => {
    const key = menuKeyFromContext(ctx);
    const state = key === null ? null : getSelectedSubscription(key);

    if (key === null || state === null) {
      return range;
    }

    const id = cacheKey(key.chatId, key.userId);
    const draft = getRepoDraft(key);
    const repos = await loadRepos(key, state.accountLogin);
    const page = getPage(id);
    const start = page * pageSize;
    const visible = repos.slice(start, start + pageSize);

    range.text(`${draft === null ? "☑️" : "☐"} All repos`, async (menuCtx) => {
      if (!(await requireChatAdminCallback(menuCtx))) {
        return;
      }

      setRepoDraft(key, null);
      menuCtx.menu.update();
    }).row();

    for (const repo of visible) {
      const checked = draft === null || draft.includes(repo.name);
      range.text(`${checked ? "☑️" : "☐"} ${repo.name}`, async (menuCtx) => {
        if (!(await requireChatAdminCallback(menuCtx))) {
          return;
        }

        toggleRepo(key, repo.name);
        menuCtx.menu.update();
      }).row();
    }

    if (repos.length > pageSize) {
      range
        .text("◀️", (menuCtx) => {
          setPage(id, page - 1);
          menuCtx.menu.update();
        })
        .text(`${page + 1}/${Math.max(1, Math.ceil(repos.length / pageSize))}`, () => undefined)
        .text("▶️", (menuCtx) => {
          setPage(id, page + 1);
          menuCtx.menu.update();
        })
        .row();
    }

    return range;
  })
  .submenu("💾 Save", filtersMenuId, async (ctx) => {
    if (!(await requireChatAdminCallback(ctx))) {
      return;
    }

    await saveRepoDraft(ctx);
  })
  .submenu("❌ Cancel", filtersMenuId, async (ctx) => {
    const key = menuKeyFromContext(ctx);

    if (key !== null) {
      clearRepoDraft(key);
    }

    await ctx.editMessageText("Filters");
  });
