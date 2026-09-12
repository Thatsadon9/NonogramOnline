import assert from "node:assert/strict";
import test from "node:test";
import { acceptsRevision, enqueueByKey, mergePendingCells } from "../lib/room-sync.ts";

test("rejects an older room snapshot", () => {
  assert.equal(acceptsRevision(12, 11), false);
  assert.equal(acceptsRevision(12, 12), true);
  assert.equal(acceptsRevision(12, 13), true);
});

test("keeps optimistic cells visible while the server catches up", () => {
  const pending = new Map([[1, { id: 3, value: 2 as const }]]);
  assert.deepEqual(mergePendingCells([0, 0, 1], pending), [0, 2, 1]);
});

test("runs updates to the same cell in the order they were clicked", async () => {
  const queues = new Map<number, Promise<void>>();
  const completed: number[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = enqueueByKey(queues, 4, async () => {
    await firstGate;
    completed.push(1);
  });
  const second = enqueueByKey(queues, 4, async () => {
    completed.push(2);
  });

  await Promise.resolve();
  assert.deepEqual(completed, []);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(completed, [1, 2]);
  assert.equal(queues.size, 0);
});

test("does not block one cell behind a different cell", async () => {
  const queues = new Map<number, Promise<void>>();
  const completed: number[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const firstCell = enqueueByKey(queues, 1, async () => {
    await firstGate;
    completed.push(1);
  });
  const secondCell = enqueueByKey(queues, 2, async () => {
    completed.push(2);
  });

  await secondCell;
  assert.deepEqual(completed, [2]);
  releaseFirst?.();
  await firstCell;
});
