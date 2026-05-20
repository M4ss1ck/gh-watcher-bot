// Tracks in-memory counters for admin diagnostics.
export type GitHubApiStatus = "200" | "304" | "4xx" | "5xx" | "error";
export type DeliveryStatus = "ok" | "empty" | "error";

export type MetricsSnapshot = {
  githubApiRequestsTotal: Record<GitHubApiStatus, number>;
  eventsCollectedTotal: Record<string, number>;
  deliveriesSentTotal: Record<DeliveryStatus, number>;
  deliveryDurationMs: number[];
  telegramApiErrorsTotal: Record<string, number>;
};

const githubApiRequestsTotal: Record<GitHubApiStatus, number> = {
  "200": 0,
  "304": 0,
  "4xx": 0,
  "5xx": 0,
  error: 0
};

const eventsCollectedTotal = new Map<string, number>();
const deliveriesSentTotal: Record<DeliveryStatus, number> = {
  ok: 0,
  empty: 0,
  error: 0
};
const telegramApiErrorsTotal = new Map<string, number>();
const deliveryDurationMs: number[] = [];

const incrementMap = (map: Map<string, number>, key: string, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

export const incrementGitHubApiRequest = (status: GitHubApiStatus): void => {
  githubApiRequestsTotal[status] += 1;
};

export const incrementEventsCollected = (type: string, by = 1): void => {
  incrementMap(eventsCollectedTotal, type, by);
};

export const incrementDeliverySent = (status: DeliveryStatus): void => {
  deliveriesSentTotal[status] += 1;
};

export const observeDeliveryDuration = (durationMs: number): void => {
  deliveryDurationMs.push(durationMs);

  if (deliveryDurationMs.length > 100) {
    deliveryDurationMs.shift();
  }
};

export const incrementTelegramApiError = (code: number | string): void => {
  incrementMap(telegramApiErrorsTotal, String(code));
};

export const getMetricsSnapshot = (): MetricsSnapshot => ({
  githubApiRequestsTotal: { ...githubApiRequestsTotal },
  eventsCollectedTotal: Object.fromEntries(eventsCollectedTotal),
  deliveriesSentTotal: { ...deliveriesSentTotal },
  deliveryDurationMs: [...deliveryDurationMs],
  telegramApiErrorsTotal: Object.fromEntries(telegramApiErrorsTotal)
});

export const resetMetricsForTests = (): void => {
  for (const key of Object.keys(githubApiRequestsTotal) as GitHubApiStatus[]) {
    githubApiRequestsTotal[key] = 0;
  }

  eventsCollectedTotal.clear();

  for (const key of Object.keys(deliveriesSentTotal) as DeliveryStatus[]) {
    deliveriesSentTotal[key] = 0;
  }

  deliveryDurationMs.length = 0;
  telegramApiErrorsTotal.clear();
};
