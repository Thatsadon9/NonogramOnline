export type PendingCell<T> = { id: number; value: T };

export function mergePendingCells<T>(serverCells: readonly T[], pending: ReadonlyMap<number, PendingCell<T>>) {
  const merged = [...serverCells];
  for (const [index, operation] of pending) {
    if (index >= 0 && index < merged.length) merged[index] = operation.value;
  }
  return merged;
}

// Strictly newer only: re-applying an equal revision would rebuild state
// objects and re-render the whole board even when nothing changed.
export function acceptsRevision(currentRevision: number, incomingRevision: number) {
  return incomingRevision > currentRevision;
}

export function cellsEqual<T>(a: readonly T[], b: readonly T[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function diffCells<T>(previous: readonly T[], next: readonly T[]): Array<{ index: number; value: T }> {
  const ops: Array<{ index: number; value: T }> = [];
  const length = Math.min(previous.length, next.length);
  for (let index = 0; index < length; index++) {
    if (previous[index] !== next[index]) ops.push({ index, value: next[index] as T });
  }
  return ops;
}

// Polling fallback cadence: snappy while the room is active, then backing off
// so idle rooms cost almost nothing.
export function nextPollInterval(idleMs: number) {
  if (idleMs < 10_000) return 400;
  if (idleMs < 30_000) return 1500;
  return 3000;
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
