// Defines the in-process delivery queue and delivery task entry point.
import PQueue from "p-queue";

import type { DeliveryTaskInput } from "~/scheduler/deliverer";

export type DeliveryQueueOptions = {
  deliver: (input: DeliveryTaskInput) => Promise<unknown>;
  concurrency?: number;
};

export type DeliveryQueue = {
  addDelivery: (input: DeliveryTaskInput) => Promise<unknown>;
  onIdle: () => Promise<void>;
};

export const createDeliveryQueue = (
  options: DeliveryQueueOptions
): DeliveryQueue => {
  const queue = new PQueue({
    concurrency: options.concurrency ?? 3,
    // Must sit above every internal deadline (the 40s AI summary budget,
    // octokit retry/throttle waits, grammY auto-retry) so it only trips on a
    // genuine hang. p-queue cannot cancel the underlying delivery: on expiry
    // the tracking promise rejects while the work keeps running.
    timeout: 180_000
  });

  return {
    addDelivery: (input) => queue.add(() => options.deliver(input)),
    onIdle: () => queue.onIdle()
  };
};
