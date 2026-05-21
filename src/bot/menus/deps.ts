// Shared singletons that menu callbacks need but cannot import directly without cycles.
import type { GitHubApiClient } from "~/github/client";
import type { Deliverer } from "~/scheduler/deliverer";

let deliverer: Deliverer | null = null;
let githubClient: GitHubApiClient | null = null;

export const setDeliverer = (instance: Deliverer): void => {
  deliverer = instance;
};

export const getDeliverer = (): Deliverer | null => deliverer;

export const setGitHubClient = (instance: GitHubApiClient): void => {
  githubClient = instance;
};

export const getGitHubClient = (): GitHubApiClient | null => githubClient;
