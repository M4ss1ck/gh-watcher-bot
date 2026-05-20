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
    timeout: 60_000
  });

  return {
    addDelivery: (input) => queue.add(() => options.deliver(input)),
    onIdle: () => queue.onIdle()
  };
};
