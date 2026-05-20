// Writes collector and deliverer heartbeat values into the kv table.
import { setKvValue } from "~/db/queries";

export const collectorHeartbeatKey = "collector.last_tick";
export const delivererHeartbeatKey = "deliverer.last_tick";

export const writeCollectorHeartbeat = async (
  date = new Date()
): Promise<void> => {
  await setKvValue({
    key: collectorHeartbeatKey,
    value: String(date.getTime()),
    updatedAt: date
  });
};

export const writeDelivererHeartbeat = async (
  date = new Date()
): Promise<void> => {
  await setKvValue({
    key: delivererHeartbeatKey,
    value: String(date.getTime()),
    updatedAt: date
  });
};
