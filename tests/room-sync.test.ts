import assert from "node:assert/strict";
import test from "node:test";
import { acceptsRevision, cellsEqual, diffCells, enqueueByKey, mergePendingCells, nextPollInterval } from "../lib/room-sync.ts";
import { autoCompletedKeys, clues, isSolvedByClues } from "../lib/nonogram.ts";
import { createProgressStore } from "../lib/progress.ts";

test("rejects an older or unchanged room snapshot", () => {
  assert.equal(acceptsRevision(12, 11), false);
  assert.equal(acceptsRevision(12, 12), false);
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

test("diffs only the cells that changed", () => {
  assert.deepEqual(diffCells([0, 1, 2], [0, 2, 2]), [{ index: 1, value: 2 }]);
  assert.deepEqual(diffCells([1, 1], [1, 1]), []);
  assert.equal(cellsEqual([1, 2], [1, 2]), true);
  assert.equal(cellsEqual([1, 2], [2, 1]), false);
});

test("backs off the polling interval as the room goes idle", () => {
  assert.equal(nextPollInterval(1_000), 400);
  assert.equal(nextPollInterval(9_999), 400);
  assert.equal(nextPollInterval(15_000), 1500);
  assert.equal(nextPollInterval(29_999), 1500);
  assert.equal(nextPollInterval(120_000), 3000);
});

test("clue numbers ignore crosses but count runs of filled cells", () => {
  assert.deepEqual(clues([1, 1, 0, 2, 1]), [2, 1]);
  assert.deepEqual(clues([2, 2, 2]), [0]);
  assert.deepEqual(clues([0, 0, 0, 1, 1, 1]), [3]);
});

test("detects a solved board from clues alone", () => {
  const solution = [1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1];
  const size = 5;
  const rowClues = Array.from({ length: size }, (_, row) => clues(solution.slice(row * size, (row + 1) * size)));
  const colClues = Array.from({ length: size }, (_, col) => clues(Array.from({ length: size }, (_, row) => solution[row * size + col])));

  assert.equal(isSolvedByClues(solution, rowClues, colClues, size), true);
  // Crosses are just annotations: a solved board stays solved with them.
  assert.equal(isSolvedByClues(solution.map((value) => (value === 0 ? 2 : value)), rowClues, colClues, size), true);
  // One missing fill breaks it.
  const broken = solution.slice();
  broken[0] = 0;
  assert.equal(isSolvedByClues(broken, rowClues, colClues, size), false);
});

test("auto-strikes clues for satisfied lines only", () => {
  const size = 5;
  const rowClues = [[2, 1], [1], [1], [2], [1]];
  const colClues = [[2], [1], [1], [2], [1]];
  const cells = [1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const keys = autoCompletedKeys(cells, rowClues, colClues, size);
  assert.equal(keys.has("row-0-0"), true);
  assert.equal(keys.has("row-0-1"), true);
  assert.equal(keys.has("row-1-0"), false);
});

test("progress store persists, validates, and keeps best times", () => {
  const backing = new Map<string, string>();
  const store = createProgressStore({
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => void backing.set(key, value),
    removeItem: (key) => void backing.delete(key),
  });

  store.saveProgress("10:1000031", { cells: Array(100).fill(1), elapsed: 42, started: true });
  const loaded = store.loadProgress("10:1000031");
  assert.equal(loaded?.elapsed, 42);
  assert.equal(loaded?.started, true);
  assert.equal(loaded?.cells.length, 100);

  // Corrupt or wrong-size boards are rejected instead of crashing the board.
  backing.set("nonogram-progress-v1", JSON.stringify({ "10:1000031": { cells: [9, 9, 9], elapsed: 1, started: true } }));
  assert.equal(store.loadProgress("10:1000031"), null);

  const first = store.recordBestTime("10:1000031", 90);
  assert.deepEqual(first, { previous: null, best: 90 });
  const second = store.recordBestTime("10:1000031", 60);
  assert.deepEqual(second, { previous: 90, best: 60 });
  assert.equal(store.loadBestTime("10:1000031"), 60);

  store.clearProgress("10:1000031");
  assert.equal(store.loadProgress("10:1000031"), null);
});
