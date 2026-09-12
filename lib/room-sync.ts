export type PendingCell<T> = { id: number; value: T };

export function mergePendingCells<T>(serverCells: readonly T[], pending: ReadonlyMap<number, PendingCell<T>>) {
  const merged = [...serverCells];
  for (const [index, operation] of pending) {
    if (index >= 0 && index < merged.length) merged[index] = operation.value;
  }
  return merged;
}

export function acceptsRevision(currentRevision: number, incomingRevision: number) {
  return incomingRevision >= currentRevision;
}

export function enqueueByKey<K>(queues: Map<K, Promise<void>>, key: K, work: () => Promise<void>) {
  const previous = queues.get(key) ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(work)
    .finally(() => {
      if (queues.get(key) === queued) queues.delete(key);
    });
  queues.set(key, queued);
  return queued;
}
