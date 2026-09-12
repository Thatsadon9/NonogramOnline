export type StoredProgress = { cells: number[]; elapsed: number; started: boolean };

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const PROGRESS_KEY = "nonogram-progress-v1";
const BEST_KEY = "nonogram-best-v1";
const MAX_STORED_PUZZLES = 30;
const VALID_LENGTHS = new Set([25, 100, 225, 400, 625]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readMap(store: StorageLike | null, key: string): Record<string, unknown> {
  try {
    const raw = store?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(store: StorageLike | null, key: string, map: Record<string, unknown>) {
  try {
    store?.setItem(key, JSON.stringify(map));
  } catch {
    // Storage can be full or blocked; losing progress persistence is fine.
  }
}

export type ProgressStore = {
  loadProgress(puzzleKey: string): StoredProgress | null;
  saveProgress(puzzleKey: string, progress: StoredProgress): void;
  clearProgress(puzzleKey: string): void;
  loadBestTime(puzzleKey: string): number | null;
  recordBestTime(puzzleKey: string, seconds: number): { previous: number | null; best: number };
};

export function createProgressStore(storage?: StorageLike): ProgressStore {
  const store = () => storage ?? defaultStorage();
  return {
    loadProgress(puzzleKey) {
      const entry = readMap(store(), PROGRESS_KEY)[puzzleKey];
      if (!isRecord(entry) || !Array.isArray(entry.cells) || !VALID_LENGTHS.has(entry.cells.length)) return null;
      if (!entry.cells.every((cell) => cell === 0 || cell === 1 || cell === 2)) return null;
      const elapsed = Number(entry.elapsed);
      return {
        cells: entry.cells.map(Number),
        elapsed: Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed)) : 0,
        started: Boolean(entry.started),
      };
    },
    saveProgress(puzzleKey, progress) {
      const map = readMap(store(), PROGRESS_KEY);
      delete map[puzzleKey];
      map[puzzleKey] = { cells: [...progress.cells], elapsed: progress.elapsed, started: progress.started };
      const keys = Object.keys(map);
      for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_STORED_PUZZLES))) delete map[stale];
      writeMap(store(), PROGRESS_KEY, map);
    },
    clearProgress(puzzleKey) {
      const map = readMap(store(), PROGRESS_KEY);
      if (!(puzzleKey in map)) return;
      delete map[puzzleKey];
      writeMap(store(), PROGRESS_KEY, map);
    },
    loadBestTime(puzzleKey) {
      const entry = readMap(store(), BEST_KEY)[puzzleKey];
      return typeof entry === "number" && Number.isFinite(entry) ? entry : null;
    },
    recordBestTime(puzzleKey, seconds) {
      const map = readMap(store(), BEST_KEY);
      const entry = map[puzzleKey];
      const previous = typeof entry === "number" && Number.isFinite(entry) ? entry : null;
      const best = previous === null ? seconds : Math.min(previous, seconds);
      map[puzzleKey] = best;
      writeMap(store(), BEST_KEY, map);
      return { previous, best };
    },
  };
}

export const progress = createProgressStore();
