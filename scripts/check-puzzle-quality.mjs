import { generateSolution, PUZZLE_SEEDS, PUZZLE_SIZES } from "../lib/puzzle-generator.ts";

function getClues(line) {
  const groups = [];
  let run = 0;
  for (const value of [...line, 0]) {
    if (value) run++;
    else if (run) { groups.push(run); run = 0; }
  }
  return groups;
}

function linePatterns(size, groups) {
  const output = [];
  const required = Array(groups.length + 1).fill(0);
  for (let index = groups.length - 1; index >= 0; index--) {
    required[index] = required[index + 1] + groups[index] + (index < groups.length - 1 ? 1 : 0);
  }

  const place = (group, start, mask) => {
    if (group === groups.length) { output.push(mask); return; }
    const lastStart = size - required[group];
    for (let position = start; position <= lastStart; position++) {
      let nextMask = mask;
      for (let offset = 0; offset < groups[group]; offset++) nextMask |= 1 << (position + offset);
      place(group + 1, position + groups[group] + 1, nextMask);
    }
  };

  place(0, 0, 0);
  return output;
}

function countSolutions(size, rowClues, columnClues) {
  const initialRows = rowClues.map((clue) => linePatterns(size, clue));
  const initialColumns = columnClues.map((clue) => linePatterns(size, clue));

  function search(grid, rowPatterns, columnPatterns) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let axis = 0; axis < 2; axis++) {
        const patternSets = axis === 0 ? rowPatterns : columnPatterns;
        for (let line = 0; line < size; line++) {
          let knownFilled = 0;
          let knownEmpty = 0;
          for (let position = 0; position < size; position++) {
            const cell = axis === 0 ? line * size + position : position * size + line;
            if (grid[cell] === 1) knownFilled |= 1 << position;
            if (grid[cell] === 0) knownEmpty |= 1 << position;
          }

          const possible = patternSets[line].filter(
            (mask) => (mask & knownFilled) === knownFilled && (mask & knownEmpty) === 0,
          );
          if (!possible.length) return 0;
          if (possible.length !== patternSets[line].length) {
            patternSets[line] = possible;
            changed = true;
          }

          let alwaysFilled = possible[0];
          let possiblyFilled = 0;
          for (const mask of possible) {
            alwaysFilled &= mask;
            possiblyFilled |= mask;
          }

          for (let position = 0; position < size; position++) {
            const cell = axis === 0 ? line * size + position : position * size + line;
            const forced = alwaysFilled & (1 << position) ? 1 : !(possiblyFilled & (1 << position)) ? 0 : -1;
            if (forced === -1) continue;
            if (grid[cell] !== -1 && grid[cell] !== forced) return 0;
            if (grid[cell] === -1) { grid[cell] = forced; changed = true; }
          }
        }
      }
    }

    if (!grid.includes(-1)) return 1;

    let bestAxis = 0;
    let bestLine = -1;
    let bestCount = Infinity;
    for (let axis = 0; axis < 2; axis++) {
      const patternSets = axis === 0 ? rowPatterns : columnPatterns;
      for (let line = 0; line < size; line++) {
        if (patternSets[line].length > 1 && patternSets[line].length < bestCount) {
          bestAxis = axis;
          bestLine = line;
          bestCount = patternSets[line].length;
        }
      }
    }
    if (bestLine < 0) return 0;

    let count = 0;
    const choices = (bestAxis === 0 ? rowPatterns : columnPatterns)[bestLine];
    for (const mask of choices) {
      const nextGrid = grid.slice();
      for (let position = 0; position < size; position++) {
        nextGrid[bestAxis === 0 ? bestLine * size + position : position * size + bestLine] = mask & (1 << position) ? 1 : 0;
      }
      const nextRows = rowPatterns.map((patterns) => patterns.slice());
      const nextColumns = columnPatterns.map((patterns) => patterns.slice());
      (bestAxis === 0 ? nextRows : nextColumns)[bestLine] = [mask];
      count += search(nextGrid, nextRows, nextColumns);
      if (count > 1) return count;
    }
    return count;
  }

  return search(
    Array(size * size).fill(-1),
    initialRows.map((patterns) => patterns.slice()),
    initialColumns.map((patterns) => patterns.slice()),
  );
}

function validatePuzzle(size, seed) {
  const minimumRuns = size * (size <= 5 ? 2.1 : size <= 10 ? 3.1 : size <= 15 ? 4.2 : size <= 20 ? 5.2 : 6.1);
  const maximumRuns = size * (size <= 5 ? 3.2 : size <= 10 ? 4.4 : size <= 15 ? 6 : size <= 20 ? 8 : 9.2);
  const solution = generateSolution(size, seed);
  const rows = Array.from({ length: size }, (_, row) => getClues(solution.slice(row * size, (row + 1) * size)));
  const columns = Array.from({ length: size }, (_, column) => getClues(Array.from({ length: size }, (_, row) => solution[row * size + column])));
  const fillRatio = solution.reduce((total, cell) => total + cell, 0) / solution.length;
  const runCount = [...rows, ...columns].reduce((total, clues) => total + clues.length, 0);

  if (seed > 2_147_483_647) return "seed exceeds PostgreSQL integer range";
  if (solution.length !== size * size) return "incorrect cell count";
  if (fillRatio < 0.38 || fillRatio > 0.64) return `fill ratio ${fillRatio}`;
  if ([...rows, ...columns].some((clues) => clues.length === 0)) return "empty line";
  if ([...rows, ...columns].some((clues) => clues.length === 1 && clues[0] === size)) return "full line";
  if (runCount < minimumRuns) return `only ${runCount} runs`;
  if (runCount > maximumRuns) return `too fragmented (${runCount} runs)`;
  if (countSolutions(size, rows, columns) !== 1) return "solution is not unique";
  return null;
}

if (process.argv.includes("--search")) {
  for (const size of PUZZLE_SIZES) {
    const found = [];
    // Keep v2 seeds below PostgreSQL int4's 2,147,483,647 ceiling.
    const start = 2_000_000_000 + size * 100_000;
    for (let offset = 1; offset <= 20_000 && found.length < 16; offset++) {
      const seed = start + offset;
      if (validatePuzzle(size, seed) === null) found.push(seed);
    }
    if (found.length < 16) throw new Error(`${size}x${size}: found only ${found.length} valid seeds`);
    console.log(`  ${size}: [${found.join(", ")}],`);
  }
  process.exit(0);
}

for (const size of PUZZLE_SIZES) {
  const grids = new Set();
  for (const seed of PUZZLE_SEEDS[size]) {
    const error = validatePuzzle(size, seed);
    if (error) throw new Error(`${size}x${size} #${seed}: ${error}`);
    const signature = generateSolution(size, seed).join("");
    if (grids.has(signature)) throw new Error(`${size}x${size} #${seed}: duplicate puzzle`);
    grids.add(signature);
  }
  console.log(`✓ ${size}x${size}: ${PUZZLE_SEEDS[size].length} unique, balanced, smooth puzzles`);
}

const checkedPuzzleCount = PUZZLE_SIZES.reduce((total, size) => total + PUZZLE_SEEDS[size].length, 0);
console.log(`✓ Checked ${checkedPuzzleCount} curated puzzles`);
