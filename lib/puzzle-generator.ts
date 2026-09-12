export const PUZZLE_SIZES = [5, 10, 15, 20, 25] as const;

export type PuzzleSize = (typeof PUZZLE_SIZES)[number];

// Seeds above this boundary use the smoother v2 generator. Keeping the v1
// path intact means rooms and saved games created before this upgrade still
// resolve to the exact same puzzle.
const SMOOTH_PUZZLE_SEED = 2_000_000_000;

// Every seed in this bank is checked by `npm run puzzle:check` for balanced
// density, varied clues, non-empty lines, and exactly one valid solution.
export const PUZZLE_SEEDS: Record<PuzzleSize, readonly number[]> = {
  5: [2000500002, 2000500005, 2000500008, 2000500012, 2000500016, 2000500019, 2000500020, 2000500024, 2000500025, 2000500027, 2000500029, 2000500030, 2000500036, 2000500045, 2000500047, 2000500052],
  10: [2001000002, 2001000008, 2001000009, 2001000014, 2001000015, 2001000020, 2001000021, 2001000024, 2001000030, 2001000031, 2001000039, 2001000040, 2001000041, 2001000043, 2001000047, 2001000049],
  15: [2001500002, 2001500011, 2001500014, 2001500016, 2001500018, 2001500020, 2001500024, 2001500026, 2001500031, 2001500033, 2001500034, 2001500045, 2001500047, 2001500048, 2001500049, 2001500050],
  20: [2002000001, 2002000004, 2002000007, 2002000010, 2002000012, 2002000020, 2002000028, 2002000030, 2002000033, 2002000051, 2002000060, 2002000061, 2002000062, 2002000081, 2002000085, 2002000089],
  25: [2002500015, 2002500019, 2002500022, 2002500023, 2002500032, 2002500034, 2002500049, 2002500053, 2002500073, 2002500076, 2002500077, 2002500089, 2002500094, 2002500100, 2002500104, 2002500115],
};

function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSolution(size: PuzzleSize, seed: number) {
  const random = seededRandom(seed);
  const cells = Array<number>(size * size).fill(0);
  const smooth = seed >= SMOOTH_PUZZLE_SEED;

  // V2 uses stronger neighbour correlation to form longer, more deliberate
  // clue runs instead of a noisy coin-flip texture. V1 stays byte-for-byte
  // compatible for rooms and saves created with the original seed bank.
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const left = column ? cells[row * size + column - 1] : 0;
      const above = row ? cells[(row - 1) * size + column] : 0;
      const diagonal = row && column ? cells[(row - 1) * size + column - 1] : 0;
      const secondLeft = column > 1 ? cells[row * size + column - 2] : 0;
      const secondAbove = row > 1 ? cells[(row - 2) * size + column] : 0;
      const wave = Math.sin((column + 1) * (smooth ? 1.17 : 1.73) + seed * 0.001)
        + Math.cos((row + 1) * 1.31 + seed * 0.002);
      const fillChance = (smooth ? 0.36 : 0.48)
        + (left ? (smooth ? 0.20 : 0.09) : (smooth ? -0.07 : -0.035))
        + (above ? (smooth ? 0.18 : 0.085) : (smooth ? -0.065 : -0.03))
        + (diagonal ? (smooth ? 0.05 : 0.025) : (smooth ? -0.018 : -0.01))
        + (smooth ? (secondLeft ? 0.035 : -0.012) + (secondAbove ? 0.035 : -0.012) : 0)
        + wave * 0.018;

      cells[row * size + column] = random() < fillChance ? 1 : 0;
    }
  }

  // Avoid giveaway clues such as 0 or a full-width line. Curated seeds are
  // subsequently verified as unique, so this repair never introduces ambiguity.
  for (let pass = 0; pass < 3; pass++) {
    for (let row = 0; row < size; row++) {
      const indices = Array.from({ length: size }, (_, column) => row * size + column);
      const filled = indices.reduce((total, index) => total + cells[index], 0);
      if (filled === 0) cells[indices[Math.floor(random() * size)]] = 1;
      if (filled === size) cells[indices[Math.floor(random() * size)]] = 0;
    }

    for (let column = 0; column < size; column++) {
      const indices = Array.from({ length: size }, (_, row) => row * size + column);
      const filled = indices.reduce((total, index) => total + cells[index], 0);
      if (filled === 0) cells[indices[Math.floor(random() * size)]] = 1;
      if (filled === size) cells[indices[Math.floor(random() * size)]] = 0;
    }
  }

  return cells;
}

export function pickPuzzleSeed(size: PuzzleSize, randomValue: number, currentSeed?: number) {
  const seeds = PUZZLE_SEEDS[size];
  const available = currentSeed === undefined ? seeds : seeds.filter((seed) => seed !== currentSeed);
  return available[randomValue % available.length];
}
