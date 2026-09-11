export const PUZZLE_SIZES = [5, 10, 15, 20, 25] as const;

export type PuzzleSize = (typeof PUZZLE_SIZES)[number];

// Every seed in this bank is checked by `npm run puzzle:check` for balanced
// density, varied clues, non-empty lines, and exactly one valid solution.
export const PUZZLE_SEEDS: Record<PuzzleSize, readonly number[]> = {
  5: [500017, 500019, 500021, 500023, 500024, 500025, 500026, 500027, 500028, 500030, 500032, 500035, 500036, 500037, 500038, 500041],
  10: [1000031, 1000032, 1000033, 1000034, 1000035, 1000037, 1000038, 1000039, 1000041, 1000042, 1000043, 1000045, 1000047, 1000049, 1000050, 1000051],
  15: [1500046, 1500047, 1500050, 1500051, 1500052, 1500054, 1500055, 1500057, 1500061, 1500064, 1500065, 1500068, 1500069, 1500071, 1500073, 1500074],
  20: [2000067, 2000069, 2000070, 2000074, 2000078, 2000083, 2000085, 2000086, 2000090, 2000099, 2000102, 2000107, 2000111, 2000113, 2000118, 2000121],
  25: [2500077, 2500078, 2500086, 2500088, 2500091, 2500097, 2500102, 2500109, 2500111, 2500117, 2500119, 2500152, 2500153, 2500161, 2500163, 2500164],
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

  // Mild neighbour correlation creates readable runs without collapsing the
  // board into a few large blobs. The wave prevents a flat coin-flip texture.
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const left = column ? cells[row * size + column - 1] : 0;
      const above = row ? cells[(row - 1) * size + column] : 0;
      const diagonal = row && column ? cells[(row - 1) * size + column - 1] : 0;
      const wave = Math.sin((column + 1) * 1.73 + seed * 0.001)
        + Math.cos((row + 1) * 1.31 + seed * 0.002);
      const fillChance = 0.48
        + (left ? 0.09 : -0.035)
        + (above ? 0.085 : -0.03)
        + (diagonal ? 0.025 : -0.01)
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
