export type CellValue = 0 | 1 | 2;

// Clue numbers for one grid line. Crosses (2) never count as filled, so the
// same helper works for solutions and for in-progress player boards.
export function clues(line: readonly number[]): number[] {
  const result: number[] = [];
  let run = 0;
  for (const value of [...line, 0]) {
    if (value === 1) run++;
    else if (run) { result.push(run); run = 0; }
  }
  return result.length ? result : [0];
}

export function computeRowClues(cells: readonly number[], size: number): number[][] {
  return Array.from({ length: size }, (_, row) => clues(cells.slice(row * size, (row + 1) * size)));
}

export function computeColClues(cells: readonly number[], size: number): number[][] {
  return Array.from({ length: size }, (_, col) => clues(Array.from({ length: size }, (_, row) => cells[row * size + col])));
}

function sameNumbers(a: readonly number[], b: readonly number[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// A board is solved when every row and column's filled runs match its clue
// numbers. Because curated puzzles have exactly one solution, this is
// equivalent to matching the hidden solution — without ever reading it.
export function isSolvedByClues(cells: readonly number[], rowClues: readonly (readonly number[])[], colClues: readonly (readonly number[])[], size: number): boolean {
  for (let row = 0; row < size; row++) {
    if (!sameNumbers(clues(cells.slice(row * size, (row + 1) * size)), rowClues[row]!)) return false;
  }
  for (let col = 0; col < size; col++) {
    const column = Array.from({ length: size }, (_, row) => cells[row * size + col]);
    if (!sameNumbers(clues(column), colClues[col]!)) return false;
  }
  return true;
}

// Clue keys (`row-<r>-<i>` / `column-<c>-<i>`) for lines whose fills already
// satisfy their clues, so the UI can strike them out automatically.
export function autoCompletedKeys(cells: readonly number[], rowClues: readonly (readonly number[])[], colClues: readonly (readonly number[])[], size: number): Set<string> {
  const keys = new Set<string>();
  for (let row = 0; row < size; row++) {
    if (sameNumbers(clues(cells.slice(row * size, (row + 1) * size)), rowClues[row]!)) {
      for (let i = 0; i < rowClues[row]!.length; i++) keys.add(`row-${row}-${i}`);
    }
  }
  for (let col = 0; col < size; col++) {
    const column = Array.from({ length: size }, (_, row) => cells[row * size + col]);
    if (sameNumbers(clues(column), colClues[col]!)) {
      for (let i = 0; i < colClues[col]!.length; i++) keys.add(`column-${col}-${i}`);
    }
  }
  return keys;
}
